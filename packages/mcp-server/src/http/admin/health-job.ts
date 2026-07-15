// src/http/admin/health-job.ts
import { verifyReachability } from '@1c-odata/mcp/internal'
import { decrypt, type Keyring } from '../../store/crypto.js'
import type { BaseRepo, HealthRepo, SecretRepo } from '../../store/repos.js'
import { classifyProbe } from './bases.js'

/**
 * The health probe is a LIGHT reachability check ({@link verifyReachability} — a
 * GET on the OData service root), NOT a full `$metadata` download: on real bases
 * the root is ~20× smaller (KB–hundreds of KB vs 10–15 MB), so a short timeout is
 * safe even on a slow link. Hence a 5s default (vs the 120s `$metadata` default).
 */
const DEFAULT_PROBE_TIMEOUT_MS = 5_000

/** Bases probed concurrently per sweep — total sweep time ≈ slowest base, not the sum. */
const HEALTH_CONCURRENCY = 6

export interface HealthJob {
  /** Run one sweep now (resolves when the sweep settles). For tests + startup seed + the "check now" button. */
  runOnce(): Promise<void>
  /**
   * Stop the timer AND await any in-flight sweep, so a probe/HealthRepo write can't
   * race the DB handle closing during shutdown. Idempotent.
   */
  stop(): Promise<void>
}

export interface HealthSweepDeps {
  baseRepo: BaseRepo
  secretRepo: SecretRepo
  healthRepo: HealthRepo
  keyring: Keyring
  probeTimeoutMs?: number
  log?: { error(obj: unknown, msg?: string): void }
}

export interface HealthJobDeps extends HealthSweepDeps {
  intervalMs?: number
}

/**
 * Probe one base and record its health. A PROBE failure (unreachable / bad creds /
 * decrypt) is turned into an auth_failed/unreachable row, not thrown; a repo/DB
 * failure (secretRepo.get / healthRepo.upsert) still rejects — the caller's
 * per-base worker catch handles that (so one base can't abort the sweep).
 */
async function probeBase(
  deps: HealthSweepDeps,
  base: { name: string; baseUrl: string; login: string },
  timeout: number,
): Promise<void> {
  const sealed = await deps.secretRepo.get(base.name)
  if (sealed === null) {
    await deps.healthRepo.upsert(base.name, 'auth_failed', 'No password assigned')
    return
  }
  let password: string
  try {
    password = decrypt(deps.keyring, base.name, sealed)
  } catch {
    await deps.healthRepo.upsert(base.name, 'auth_failed', 'Secret decryption failed')
    return
  }
  try {
    await verifyReachability({ baseUrl: base.baseUrl, login: base.login, password, timeout })
    await deps.healthRepo.upsert(base.name, 'ok')
  } catch (err) {
    const { status, message } = classifyProbe(err)
    await deps.healthRepo.upsert(base.name, status, message)
  }
}

/**
 * Probe every base once (LIGHT reachability probe) and record ok / auth_failed /
 * unreachable in HealthRepo. The shared body of the periodic job (below) AND the
 * admin panel's on-demand "check now" button. Bases are probed with bounded
 * concurrency ({@link HEALTH_CONCURRENCY}), so the sweep time is ≈ the slowest
 * single base rather than the sum. Never throws — a sweep-level failure is logged,
 * not propagated (so the timer / the request handler can't crash).
 */
export async function runHealthSweep(deps: HealthSweepDeps): Promise<void> {
  const timeout = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  try {
    const bases = await deps.baseRepo.list()
    // Bounded worker pool: `HEALTH_CONCURRENCY` workers pull from a shared index.
    // Single-threaded JS makes `i++` atomic (no await between read and increment),
    // so every worker gets a distinct base.
    let i = 0
    const workers = Array.from({ length: Math.min(HEALTH_CONCURRENCY, bases.length) }, async () => {
      while (i < bases.length) {
        const base = bases[i++]
        if (base === undefined) continue
        try {
          await probeBase(deps, base, timeout)
        } catch (err) {
          // A repo/DB write failure for THIS base must not reject the worker: that
          // would make Promise.all settle early while other workers still run,
          // breaking stop()'s "await every in-flight sweep" guarantee (a late write
          // could then race the DB handle closing). Log and keep draining.
          deps.log?.error(
            { err: err instanceof Error ? err.message : String(err), base: base.name },
            'health probe failed',
          )
        }
      }
    })
    await Promise.all(workers)
  } catch (err) {
    // Log a serializable shape: a bare Error stringifies to `{}` under the JSON
    // sink, dropping the message. Never let a sweep throw out of the caller.
    deps.log?.error({ err: err instanceof Error ? err.message : String(err) }, 'health sweep failed')
  }
}

/**
 * Single-instance periodic health job: every intervalMs, run {@link runHealthSweep}.
 * No cross-replica coordination — one writer assumed (pglite is single-process;
 * multi-replica pg would multiply probe load — tracked separately).
 */
export function startHealthJob(deps: HealthJobDeps): HealthJob {
  // Floor the interval at 1s (this is a PUBLIC function, callable outside the env
  // path): a tiny value would both hammer the 1С servers and leave no room for a
  // positive probe timeout below it. So the interval is always ≥ 1000ms.
  const intervalMs = Math.max(1000, deps.intervalMs ?? 60_000)
  // #97: the probe timeout must stay BELOW the scheduling interval — a probe that
  // can outlast the period is an invalid config. Clamp it below the interval (the
  // re-entrancy guard would coalesce a late sweep anyway, but this keeps the
  // configured timing honest) and surface the misconfiguration. The interval floor
  // above guarantees the clamped result stays positive (≥ 999ms).
  let probeTimeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  // Defensive (public fn): a non-positive / non-finite override (0, negative, NaN)
  // would forward an invalid timeout to the transport — fall back to the default.
  if (!Number.isFinite(probeTimeoutMs) || probeTimeoutMs <= 0) probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS
  if (probeTimeoutMs >= intervalMs) {
    deps.log?.error({ probeTimeoutMs, intervalMs }, 'health probe timeout >= interval; clamped below the interval')
    probeTimeoutMs = intervalMs - 1
  }
  const sweepDeps: HealthSweepDeps = { ...deps, probeTimeoutMs }
  let running = false
  // The currently-running sweep (or a settled promise). `stop()` awaits it so an
  // in-flight probe/write can't race the DB handle closing at shutdown.
  let inflight: Promise<void> = Promise.resolve()

  /** Start a sweep, or return the in-flight one — a slow sweep must not stack (re-entrancy guard). */
  function sweep(): Promise<void> {
    if (running) return inflight
    running = true
    inflight = runHealthSweep(sweepDeps).finally(() => {
      running = false
    })
    return inflight
  }

  const timer = setInterval(() => void sweep(), intervalMs)
  timer.unref?.() // don't keep the event loop alive
  return {
    runOnce: sweep,
    async stop() {
      clearInterval(timer)
      await inflight
    },
  }
}
