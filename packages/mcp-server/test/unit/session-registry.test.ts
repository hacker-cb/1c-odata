// test/unit/session-registry.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../../src/http/session-registry.js'

/** A transport stub exposing just `close()` (what the registry drives) + a close counter. */
type FakeTransport = { close: () => Promise<void>; closed: number }

function fakeTransport(): FakeTransport {
  const t: FakeTransport = {
    closed: 0,
    close(): Promise<void> {
      t.closed += 1
      return Promise.resolve()
    },
  }
  return t
}

/**
 * Drive one full success-path session through the registry: reserve → commit →
 * release (the finally). Returns the transport (so tests can assert it was closed on
 * sweep). Throws if the reservation was refused, so a test expecting success fails loudly.
 */
function openSession(reg: SessionRegistry<FakeTransport>, sub: string | undefined, sid: string): FakeTransport {
  const rsv = reg.reserve(sub)
  if (rsv === undefined) throw new Error(`reserve refused for ${sid}`)
  const t = fakeTransport()
  rsv.commit(sid, t)
  rsv.release()
  return t
}

describe('SessionRegistry', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('commit adds a live session and remove drops it', () => {
    const reg = new SessionRegistry<FakeTransport>({ now: () => 0 })
    openSession(reg, 'alice', 's1')
    expect(reg.size).toBe(1)
    expect(reg.get('s1')).toBeDefined()
    reg.remove('s1')
    expect(reg.size).toBe(0)
    expect(reg.get('s1')).toBeUndefined()
  })

  it('enforces the global cap, counting IN-FLIGHT reservations (not just live)', () => {
    const reg = new SessionRegistry<FakeTransport>({ maxSessions: 2, now: () => 0 })
    // Two OPEN reservations, neither committed → nothing live yet, but pending == 2.
    const r1 = reg.reserve('a')
    const r2 = reg.reserve('b')
    expect(r1).toBeDefined()
    expect(r2).toBeDefined()
    expect(reg.size).toBe(0)
    // A third init must be refused by the cap even though size === 0 (burst safety).
    expect(reg.reserve('c')).toBeUndefined()
    // Releasing one frees a slot.
    r1?.release()
    expect(reg.reserve('c')).toBeDefined()
  })

  it('enforces a per-sub quota without starving other principals', () => {
    const reg = new SessionRegistry<FakeTransport>({ maxSessions: 100, maxSessionsPerSub: 2, now: () => 0 })
    openSession(reg, 'alice', 'a1')
    openSession(reg, 'alice', 'a2')
    // alice is at her quota → refused, even though the global pool is nearly empty.
    expect(reg.reserve('alice')).toBeUndefined()
    // bob is unaffected — fairness: one tenant can't starve another.
    expect(reg.reserve('bob')).toBeDefined()
  })

  it('exempts the no-auth principal (sub undefined) from the per-sub quota', () => {
    const reg = new SessionRegistry<FakeTransport>({ maxSessions: 100, maxSessionsPerSub: 1, now: () => 0 })
    openSession(reg, undefined, 'n1')
    openSession(reg, undefined, 'n2')
    openSession(reg, undefined, 'n3')
    // Only the global cap gates the single trusted principal.
    expect(reg.size).toBe(3)
    expect(reg.reserve(undefined)).toBeDefined()
  })

  it('reaps sessions idle beyond idleMs, closing their transports; fresh ones survive', () => {
    let clock = 0
    const reg = new SessionRegistry<FakeTransport>({ idleMs: 1000, now: () => clock })
    const stale = openSession(reg, 'alice', 'old')
    clock = 500
    const fresh = openSession(reg, 'alice', 'new') // stamped at 500
    clock = 1200 // old(0) is > 1000 behind; new(500) is only 700 behind
    expect(reg.sweepIdle()).toBe(1)
    expect(reg.size).toBe(1)
    expect(stale.closed).toBe(1)
    expect(fresh.closed).toBe(0)
    expect(reg.get('old')).toBeUndefined()
    expect(reg.get('new')).toBeDefined()
  })

  it('touch() resets the idle clock so an active session is not reaped', () => {
    let clock = 0
    const reg = new SessionRegistry<FakeTransport>({ idleMs: 1000, now: () => clock })
    openSession(reg, 'alice', 's1')
    clock = 900
    reg.touch('s1') // activity just before the cutoff
    clock = 1500 // 1500 - 900 = 600 < 1000 → still fresh
    expect(reg.sweepIdle()).toBe(0)
    expect(reg.size).toBe(1)
  })

  it('a session holding an open GET stream is exempt from idle-reaping until the stream closes', () => {
    let clock = 0
    const reg = new SessionRegistry<FakeTransport>({ idleMs: 1000, now: () => clock })
    const t = openSession(reg, 'alice', 's1')
    reg.streamOpened('s1') // a live SSE stream now backs the session
    clock = 100000 // far past idle
    expect(reg.sweepIdle()).toBe(0) // connected client — NOT reaped
    expect(reg.size).toBe(1)
    expect(t.closed).toBe(0)
    // Stream closes → exemption lifted → the now-idle session is reapable.
    reg.streamClosed('s1')
    expect(reg.sweepIdle()).toBe(1)
    expect(reg.size).toBe(0)
    expect(t.closed).toBe(1)
  })

  it('streamOpened is a counter — a racing second GET closing keeps the first stream exempt; no underflow', () => {
    let clock = 0
    const reg = new SessionRegistry<FakeTransport>({ idleMs: 1000, now: () => clock })
    openSession(reg, 'alice', 's1')
    reg.streamOpened('s1') // the real stream
    reg.streamOpened('s1') // a racing second GET
    reg.streamClosed('s1') // the racing GET closes
    clock = 100000
    expect(reg.sweepIdle()).toBe(0) // still exempt — first stream is live
    reg.streamClosed('s1') // first stream closes
    reg.streamClosed('s1') // extra close must not underflow the counter
    expect(reg.sweepIdle()).toBe(1) // now reapable
  })

  it('reserve() opportunistically reaps stale sessions so a returning principal gets a slot', () => {
    let clock = 0
    const reg = new SessionRegistry<FakeTransport>({ maxSessionsPerSub: 1, idleMs: 1000, now: () => clock })
    const stale = openSession(reg, 'alice', 'old')
    // Without a sweep alice is at her 1-session quota. Advance past idle and reserve:
    // the sweep inside reserve() reclaims the stale session first → the slot is free.
    clock = 5000
    const rsv = reg.reserve('alice')
    expect(rsv).toBeDefined()
    expect(stale.closed).toBe(1)
    expect(reg.size).toBe(0) // old reaped; the new one isn't committed yet
  })

  it('remove() is idempotent — a double call never double-decrements the per-sub count', () => {
    const reg = new SessionRegistry<FakeTransport>({ maxSessions: 100, maxSessionsPerSub: 2, now: () => 0 })
    openSession(reg, 'alice', 'a1')
    openSession(reg, 'alice', 'a2') // alice at cap (2)
    reg.remove('a1')
    reg.remove('a1') // double remove (sweep + onclose both fire) — must count as ONE
    // alice now has exactly 1 live (a2). She can open exactly ONE more, then hit the cap.
    expect(reg.reserve('alice')).toBeDefined() // → would-be a3 (count 2)
    // a3 was only reserved (pending), so with a2 live + a3 pending she's at cap again.
    expect(reg.reserve('alice')).toBeUndefined()
  })

  it('release() is idempotent — the finally after commit only clears pending, not the live count', () => {
    const reg = new SessionRegistry<FakeTransport>({ maxSessions: 100, maxSessionsPerSub: 1, now: () => 0 })
    const rsv = reg.reserve('alice')
    expect(rsv).toBeDefined()
    const t = fakeTransport()
    rsv?.commit('s1', t)
    rsv?.release()
    rsv?.release() // extra release must be a no-op
    // The committed session still counts against the quota (release didn't drop it).
    expect(reg.size).toBe(1)
    expect(reg.reserve('alice')).toBeUndefined()
  })

  it('the background sweeper runs on its interval and stop() halts it', () => {
    vi.useFakeTimers()
    let clock = 0
    const reg = new SessionRegistry<FakeTransport>({ idleMs: 1000, sweepIntervalMs: 500, now: () => clock })
    openSession(reg, 'alice', 's1')
    reg.start()
    clock = 5000 // now stale
    vi.advanceTimersByTime(500) // one tick → sweep reaps it
    expect(reg.size).toBe(0)
    // After stop() no further sweeps run (a fresh session survives indefinitely).
    reg.stop()
    openSession(reg, 'bob', 's2')
    clock = 100000
    vi.advanceTimersByTime(5000)
    expect(reg.size).toBe(1)
  })

  it('sweepIntervalMs <= 0 disables the background timer (sweeps still run on reserve)', () => {
    vi.useFakeTimers()
    let clock = 0
    const reg = new SessionRegistry<FakeTransport>({ idleMs: 1000, sweepIntervalMs: 0, now: () => clock })
    openSession(reg, 'alice', 's1')
    reg.start() // no-op
    clock = 5000
    vi.advanceTimersByTime(100000)
    expect(reg.size).toBe(1) // never swept by a timer
    reg.stop() // idempotent, safe with no timer
  })
})
