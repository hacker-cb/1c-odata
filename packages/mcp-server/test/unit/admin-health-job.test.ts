// test/unit/admin-health-job.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@1c-odata/mcp/internal', async (orig) => {
  const actual = await orig<typeof import('@1c-odata/mcp/internal')>()
  return { ...actual, verifyReachability: vi.fn() }
})

import { verifyReachability } from '@1c-odata/mcp/internal'
import { startHealthJob } from '../../src/http/admin/health-job.js'
import { encrypt, type Keyring, loadKeyring } from '../../src/store/crypto.js'
import { createDb, type DbHandle } from '../../src/store/db.js'
import { runAuthMigrations } from '../../src/store/migrate.js'
import { BaseRepo, HealthRepo, SecretRepo } from '../../src/store/repos.js'

const KEY = Buffer.alloc(32, 9).toString('base64')

describe('health job', () => {
  let handle: DbHandle
  let keyring: Keyring
  beforeEach(async () => {
    handle = createDb({ kind: 'pglite' })
    await runAuthMigrations(handle)
    keyring = loadKeyring({ ONEC_MCP_ENC_KEY: KEY } as NodeJS.ProcessEnv)
    vi.mocked(verifyReachability).mockReset()
  })

  // pglite is a full WASM Postgres per handle and `beforeEach` makes a NEW one for
  // every test — without this the suite piles them up for the whole file.
  afterEach(async () => {
    await handle.close()
  })

  it('writes ok / auth_failed / unreachable rows', async () => {
    const db = handle.db
    const bases = new BaseRepo(db)
    const secrets = new SecretRepo(db)
    const health = new HealthRepo(db)
    await bases.upsert('good', { baseUrl: 'http://g', login: 'u', serverTimezone: 'Europe/Moscow' })
    await secrets.put('good', encrypt(keyring, 'good', 'p'))
    await bases.upsert('nopass', { baseUrl: 'http://n', login: 'u', serverTimezone: 'Europe/Moscow' })
    await bases.upsert('down', { baseUrl: 'http://d', login: 'u', serverTimezone: 'Europe/Moscow' })
    await secrets.put('down', encrypt(keyring, 'down', 'p'))

    vi.mocked(verifyReachability).mockImplementation(async (i) => {
      if (i.baseUrl === 'http://d') throw new Error('ECONNREFUSED')
    })

    const job = startHealthJob({
      baseRepo: bases,
      secretRepo: secrets,
      healthRepo: health,
      keyring,
      intervalMs: 1_000_000,
    })
    await job.runOnce()
    await job.stop()

    const rows = Object.fromEntries((await health.list()).map((h) => [h.baseName, h.status]))
    expect(rows).toEqual({ good: 'ok', nopass: 'auth_failed', down: 'unreachable' })
  })

  it('a per-base write failure is caught — the sweep resolves + logs, never rejects', async () => {
    const bases = new BaseRepo(handle.db)
    const secrets = new SecretRepo(handle.db)
    const health = new HealthRepo(handle.db)
    await bases.upsert('a', { baseUrl: 'http://a', login: 'u', serverTimezone: 'Europe/Moscow' })
    await secrets.put('a', encrypt(keyring, 'a', 'p'))
    vi.mocked(verifyReachability).mockResolvedValue()
    // The health write throws — a worker rejection here would let Promise.all settle
    // early while other workers run, breaking stop()'s guarantee. The per-base catch
    // must swallow it: the sweep resolves and the failure is logged.
    vi.spyOn(health, 'upsert').mockRejectedValue(new Error('db write failed'))
    const errs: unknown[] = []
    const job = startHealthJob({
      baseRepo: bases,
      secretRepo: secrets,
      healthRepo: health,
      keyring,
      intervalMs: 1_000_000,
      log: { error: (o) => errs.push(o) },
    })
    await expect(job.runOnce()).resolves.toBeUndefined() // does NOT reject
    await job.stop()
    expect(errs.length).toBeGreaterThan(0) // the write failure was logged
  })

  it('clamps a probe timeout that is >= the interval (#97: timeout must stay below interval)', async () => {
    const bases = new BaseRepo(handle.db)
    const secrets = new SecretRepo(handle.db)
    await bases.upsert('a', { baseUrl: 'http://a', login: 'u', serverTimezone: 'Europe/Moscow' })
    await secrets.put('a', encrypt(keyring, 'a', 'p'))
    let seenTimeout = -1
    vi.mocked(verifyReachability).mockImplementation(async (i) => {
      seenTimeout = i.timeout ?? -1
    })
    const job = startHealthJob({
      baseRepo: bases,
      secretRepo: secrets,
      healthRepo: new HealthRepo(handle.db),
      keyring,
      intervalMs: 2000,
      probeTimeoutMs: 5000, // >= interval — must be clamped below it
      log: { error: () => {} },
    })
    await job.runOnce()
    await job.stop()
    expect(seenTimeout).toBeLessThan(2000)
    expect(seenTimeout).toBeGreaterThan(0)
  })

  it('floors a sub-second interval so the clamped probe timeout stays positive (#97 edge)', async () => {
    const bases = new BaseRepo(handle.db)
    const secrets = new SecretRepo(handle.db)
    await bases.upsert('a', { baseUrl: 'http://a', login: 'u', serverTimezone: 'Europe/Moscow' })
    await secrets.put('a', encrypt(keyring, 'a', 'p'))
    let seenTimeout = -1
    vi.mocked(verifyReachability).mockImplementation(async (i) => {
      seenTimeout = i.timeout ?? -1
    })
    // intervalMs=1 would make `interval - 1 = 0` (invalid) without the 1s floor.
    const job = startHealthJob({
      baseRepo: bases,
      secretRepo: secrets,
      healthRepo: new HealthRepo(handle.db),
      keyring,
      intervalMs: 1,
      probeTimeoutMs: 5000,
      log: { error: () => {} },
    })
    await job.runOnce()
    await job.stop()
    expect(seenTimeout).toBeGreaterThan(0) // interval floored to 1000 → clamp to 999
  })

  it('falls back to a positive default for a non-positive/NaN probe timeout (defensive)', async () => {
    const bases = new BaseRepo(handle.db)
    const secrets = new SecretRepo(handle.db)
    await bases.upsert('a', { baseUrl: 'http://a', login: 'u', serverTimezone: 'Europe/Moscow' })
    await secrets.put('a', encrypt(keyring, 'a', 'p'))
    let seenTimeout = -1
    vi.mocked(verifyReachability).mockImplementation(async (i) => {
      seenTimeout = i.timeout ?? -1
    })
    const job = startHealthJob({
      baseRepo: bases,
      secretRepo: secrets,
      healthRepo: new HealthRepo(handle.db),
      keyring,
      probeTimeoutMs: 0, // invalid — must fall back to the positive default, not stay 0
      log: { error: () => {} },
    })
    await job.runOnce()
    await job.stop()
    expect(seenTimeout).toBeGreaterThan(0)
  })

  it('runOnce coalesces concurrent calls onto ONE in-flight sweep (shared guard)', async () => {
    // This guard now backs BOTH the timer and the admin "check now" button (which
    // calls runOnce), so overlapping presses must not double-probe.
    const bases = new BaseRepo(handle.db)
    const secrets = new SecretRepo(handle.db)
    await bases.upsert('b', { baseUrl: 'http://b', login: 'u', serverTimezone: 'Europe/Moscow' })
    await secrets.put('b', encrypt(keyring, 'b', 'p'))
    // Slow probe so the two runOnce calls genuinely overlap.
    vi.mocked(verifyReachability).mockImplementation(() => new Promise((r) => setTimeout(r, 25)))

    const job = startHealthJob({
      baseRepo: bases,
      secretRepo: secrets,
      healthRepo: new HealthRepo(handle.db),
      keyring,
      intervalMs: 1_000_000,
    })
    await Promise.all([job.runOnce(), job.runOnce()]) // two overlapping sweeps
    await job.stop()
    expect(verifyReachability).toHaveBeenCalledTimes(1) // coalesced to a single sweep
  })

  it('stop() clears the interval (no leaked timer)', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    const bases = new BaseRepo(handle.db)
    const job = startHealthJob({
      baseRepo: bases,
      secretRepo: new SecretRepo(handle.db),
      healthRepo: new HealthRepo(handle.db),
      keyring,
      intervalMs: 1_000_000,
    })
    await job.stop()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})
