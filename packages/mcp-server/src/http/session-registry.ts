// src/http/session-registry.ts
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

/** Hard ceiling on concurrent live sessions across ALL principals — a burst of abandoned inits can't OOM the process. */
export const DEFAULT_MAX_SESSIONS = 1024
/**
 * Per-principal (`sub`) concurrent-session cap. Without it one tenant could occupy
 * every global slot and 503 everyone else (a cross-tenant DoS). Generous for a
 * human driving the connector across many chats; a real cap only under abuse.
 */
export const DEFAULT_MAX_SESSIONS_PER_SUB = 32
/**
 * A session untouched for longer than this is reaped by the sweeper. Targets the
 * POST-only leak: a client that `initialize`d but never opened a GET stream and
 * never sent DELETE would otherwise linger forever (the SDK's `onclose` fires only
 * on an explicit DELETE). 30 min comfortably outlives normal client think-time.
 */
export const DEFAULT_SESSION_IDLE_MS = 30 * 60_000
/** How often the background sweeper runs. */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000

/** The only transport surface the registry drives — the SDK transport satisfies it (the default type param). */
type ReclaimableTransport = { close(): Promise<void> }

/** One live session: its transport, the `sub` that opened it, and its last-activity stamp. */
interface SessionEntry<T extends ReclaimableTransport> {
  transport: T
  // `| undefined` (not optional-only): the no-auth path stores `undefined` here
  // deliberately and the per-sub quota treats that principal as exempt.
  sub: string | undefined
  /** ms epoch of the last request that touched this session; the sweeper reaps stale ones. */
  lastActivity: number
}

/** Session cap + idle-sweep knobs. Every field defaults (see the DEFAULT_* consts). */
export interface SessionTuning {
  /** Global concurrent-session ceiling across all principals. */
  maxSessions?: number
  /** Per-`sub` concurrent-session cap (the no-auth `undefined` principal is exempt). */
  maxSessionsPerSub?: number
  /** Reap a session after this many ms of inactivity. */
  idleMs?: number
  /** Background sweeper period; `<= 0` disables the timer (sweeps still run on `reserve`). */
  sweepIntervalMs?: number
}

export interface SessionRegistryOptions extends SessionTuning {
  /** Injectable clock (tests). Default {@link Date.now}. */
  now?: () => number
}

/**
 * An in-flight init slot reserved against the caps. The session only lands in the
 * live map when `onsessioninitialized` fires (mid-`handleRequest`), so the caller
 * MUST pair a successful {@link SessionRegistry.reserve} with exactly one of:
 *   - `commit(sid, transport)` on `onsessioninitialized`, AND `release()` in a
 *     `finally` (both run on the success path — the reservation double-counts in
 *     the caps for the brief window between them, which is conservative/safe), or
 *   - `release()` alone in a `finally` when the init never initialized.
 * `release()` is idempotent — calling it after `commit` (the normal success path)
 * drops only the pending reservation, never the committed live count.
 */
export interface SessionReservation<T extends ReclaimableTransport> {
  /** The init succeeded: register the live session under its generated id. */
  commit(sid: string, transport: T): void
  /** Drop the in-flight reservation. Idempotent; always call in a `finally`. */
  release(): void
}

/**
 * Owns the live-session map and enforces two independent limits plus idle reclaim:
 *
 *   - a **global cap** (`maxSessions`) so a burst of abandoned inits can't OOM the
 *     process, and
 *   - a **per-`sub` quota** (`maxSessionsPerSub`) so one tenant can't occupy every
 *     global slot and 503 everyone else. The no-auth path (`sub === undefined`) is
 *     a single trusted principal and is exempt from the per-sub quota.
 *
 * Both caps count in-flight reservations (`pending`) on top of live sessions, so a
 * burst of concurrent inits can't slip past a size-only check during the
 * `await connect()` gap.
 *
 * Idle sessions are reaped two ways: opportunistically at the head of every
 * {@link reserve} (a returning principal whose old sessions went stale reclaims a
 * slot immediately, without waiting for a tick), and by an optional background
 * `unref()` timer ({@link start}/{@link stop}). Reaping is safe because no
 * `eventStore` is configured — sessions are not resumable, so a client whose
 * session was swept simply re-initializes (see the 404 path in mcp-route.ts).
 */
export class SessionRegistry<T extends ReclaimableTransport = StreamableHTTPServerTransport> {
  private readonly sessions = new Map<string, SessionEntry<T>>()
  /** Live-session count per `sub` (keyed by the sub string; the exempt `undefined` principal is never keyed). */
  private readonly liveBySub = new Map<string, number>()
  /** In-flight reservation count per `sub`, mirroring {@link liveBySub}. */
  private readonly pendingBySub = new Map<string, number>()
  private pendingTotal = 0
  private readonly maxSessions: number
  private readonly maxSessionsPerSub: number
  private readonly idleMs: number
  private readonly sweepIntervalMs: number
  private readonly now: () => number
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(opts: SessionRegistryOptions = {}) {
    this.maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS
    this.maxSessionsPerSub = opts.maxSessionsPerSub ?? DEFAULT_MAX_SESSIONS_PER_SUB
    this.idleMs = opts.idleMs ?? DEFAULT_SESSION_IDLE_MS
    this.sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
    this.now = opts.now ?? Date.now
  }

  /** Number of live sessions (excludes in-flight reservations). */
  get size(): number {
    return this.sessions.size
  }

  /**
   * Reserve an init slot for `sub`, or return `undefined` when a cap is hit (the
   * caller answers 503). Runs an opportunistic idle-sweep FIRST so a returning
   * principal whose old sessions have gone stale reclaims a slot right away.
   */
  reserve(sub: string | undefined): SessionReservation<T> | undefined {
    this.sweepIdle()
    if (this.sessions.size + this.pendingTotal >= this.maxSessions) return undefined
    if (sub !== undefined) {
      const used = (this.liveBySub.get(sub) ?? 0) + (this.pendingBySub.get(sub) ?? 0)
      if (used >= this.maxSessionsPerSub) return undefined
    }
    this.pendingTotal += 1
    if (sub !== undefined) this.pendingBySub.set(sub, (this.pendingBySub.get(sub) ?? 0) + 1)

    let released = false
    return {
      commit: (sid, transport) => {
        this.sessions.set(sid, { transport, sub, lastActivity: this.now() })
        if (sub !== undefined) this.liveBySub.set(sub, (this.liveBySub.get(sub) ?? 0) + 1)
      },
      release: () => {
        if (released) return // idempotent: commit's success path also calls this in a finally
        released = true
        this.pendingTotal -= 1
        if (sub !== undefined) this.decrement(this.pendingBySub, sub)
      },
    }
  }

  /** Look up a live session. Does NOT stamp activity — use {@link touch} for that. */
  get(sid: string): SessionEntry<T> | undefined {
    return this.sessions.get(sid)
  }

  /**
   * Drop a live session, decrementing its principal's count. Idempotent: the sweep
   * removes an entry and then `transport.close()` fires `onclose` → `remove` again,
   * so the guard on a present entry stops a double per-sub decrement.
   */
  remove(sid: string): void {
    const entry = this.sessions.get(sid)
    if (entry === undefined) return
    this.sessions.delete(sid)
    if (entry.sub !== undefined) this.decrement(this.liveBySub, entry.sub)
  }

  /** Stamp `lastActivity = now()` on a live session so the sweeper won't reap it. */
  touch(sid: string): void {
    const entry = this.sessions.get(sid)
    if (entry !== undefined) entry.lastActivity = this.now()
  }

  /**
   * Reap every session idle beyond `idleMs`, returning the count swept. Collects the
   * stale ids first (so closing — which re-enters `remove` via `onclose` — never
   * mutates the map mid-iteration), removes each from the map, then fires a
   * best-effort `transport.close()` whose failure is swallowed (a reap must not
   * surface an unhandledRejection and crash the multi-tenant process).
   */
  sweepIdle(): number {
    const cutoff = this.now() - this.idleMs
    const stale: Array<{ sid: string; transport: T }> = []
    for (const [sid, entry] of this.sessions) {
      if (entry.lastActivity <= cutoff) stale.push({ sid, transport: entry.transport })
    }
    for (const { sid, transport } of stale) {
      this.remove(sid) // drop from map + counter BEFORE close, so onclose's remove is a no-op
      try {
        void transport.close().catch(() => {})
      } catch {
        // ignore — best-effort reap of an abandoned session
      }
    }
    return stale.length
  }

  /** Start the background sweeper (`unref()`ed so it never keeps the event loop alive). No-op if already started or disabled. */
  start(): void {
    if (this.timer !== undefined || this.sweepIntervalMs <= 0) return
    this.timer = setInterval(() => {
      this.sweepIdle()
    }, this.sweepIntervalMs)
    this.timer.unref?.()
  }

  /** Stop the background sweeper. Idempotent. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** Decrement a per-sub counter, deleting the key at zero so the maps don't grow unbounded. */
  private decrement(counts: Map<string, number>, sub: string): void {
    const next = (counts.get(sub) ?? 1) - 1
    if (next <= 0) counts.delete(sub)
    else counts.set(sub, next)
  }
}
