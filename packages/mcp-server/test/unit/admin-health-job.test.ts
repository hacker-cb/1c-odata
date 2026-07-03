// test/unit/admin-health-job.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@1c-odata/mcp/internal', async (orig) => {
  const actual = await orig<typeof import('@1c-odata/mcp/internal')>()
  return { ...actual, verifyConnectivity: vi.fn() }
})

import { verifyConnectivity } from '@1c-odata/mcp/internal'
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
    vi.mocked(verifyConnectivity).mockReset()
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

    vi.mocked(verifyConnectivity).mockImplementation(async (i) => {
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
    job.stop()

    const rows = Object.fromEntries((await health.list()).map((h) => [h.baseName, h.status]))
    expect(rows).toEqual({ good: 'ok', nopass: 'auth_failed', down: 'unreachable' })
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
    job.stop()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})
