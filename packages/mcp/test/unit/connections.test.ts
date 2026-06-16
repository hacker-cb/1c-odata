import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { assertAddable, removeConnection, upsertConnection } from '../../src/connections.js'
import { SecretStore } from '../../src/secret-store.js'

// Isolate from the real OS keychain (best-effort keychain deletes on write/remove).
vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    getPassword(): string | null {
      return null
    }
    setPassword(): void {}
    deletePassword(): boolean {
      return false
    }
  },
}))

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-conn-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// insecure: true keeps the password on the deterministic file backend.
const base = {
  baseUrl: 'http://host/odata/standard.odata',
  login: 'u',
  serverTimezone: 'Europe/Moscow',
  insecure: true,
} as const

const fileStore = () => new SecretStore({ dataDir: dir, insecure: true, warn: () => {} })

describe('upsertConnection', () => {
  it('saves the config and stores the password', async () => {
    const result = await upsertConnection({ ...base, dataDir: dir, name: 'trade', password: 'pw' })
    expect(result).toEqual({ overwritten: false, passwordBackend: 'file' })
    expect(loadConfig(dir).connections.trade).toEqual({
      baseUrl: 'http://host/odata/standard.odata',
      login: 'u',
      serverTimezone: 'Europe/Moscow',
    })
    expect(await fileStore().read('trade')).toEqual({ password: 'pw', source: 'file' })
  })

  it('stores the password verbatim — never trims edge whitespace', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', password: '  s p a c e s  ' })
    expect(await fileStore().read('trade')).toEqual({ password: '  s p a c e s  ', source: 'file' })
  })

  it('saves config only when no password is given', async () => {
    const result = await upsertConnection({ ...base, dataDir: dir, name: 'trade' })
    expect(result.passwordBackend).toBeUndefined()
    expect(loadConfig(dir).connections.trade?.login).toBe('u')
    expect(await fileStore().read('trade')).toBeNull()
  })

  it('trims surrounding whitespace from serverTimezone (so a valid zone is not rejected)', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', serverTimezone: '  Europe/Moscow  ' })
    expect(loadConfig(dir).connections.trade?.serverTimezone).toBe('Europe/Moscow')
  })

  it('strips userinfo from baseUrl before saving', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', baseUrl: 'http://u:p@host/odata' })
    expect(loadConfig(dir).connections.trade?.baseUrl).toBe('http://host/odata')
  })

  it('refuses to overwrite an existing connection by default', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade' })
    await expect(upsertConnection({ ...base, dataDir: dir, name: 'trade' })).rejects.toThrow(/already exists/)
  })

  it('overwrites with overwrite: true', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', login: 'old' })
    const result = await upsertConnection({ ...base, dataDir: dir, name: 'trade', login: 'new', overwrite: true })
    expect(result.overwritten).toBe(true)
    expect(loadConfig(dir).connections.trade?.login).toBe('new')
  })

  it('rejects an invalid (non-ASCII) connection name', async () => {
    await expect(upsertConnection({ ...base, dataDir: dir, name: 'Валюта' })).rejects.toThrow(/Invalid connection name/)
  })

  it('rejects a name colliding on the password env var with a DIFFERENT connection', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'tvip-trade', password: 'pw' })
    // 'tvip_trade' slugs to the same ONEC_TVIP_TRADE_PASSWORD as 'tvip-trade';
    // allowing it would let the new connection resolve the other's env password.
    await expect(upsertConnection({ ...base, dataDir: dir, name: 'tvip_trade' })).rejects.toThrow(/collides/)
    // Re-saving the SAME name is fine (not a cross-connection collision).
    await expect(
      upsertConnection({ ...base, dataDir: dir, name: 'tvip-trade', overwrite: true }),
    ).resolves.toBeDefined()
  })

  it('clears the stored password on a passwordless overwrite that changes the auth target', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', password: 'pw' })
    const r = await upsertConnection({
      ...base,
      dataDir: dir,
      name: 'trade',
      baseUrl: 'http://other/odata',
      overwrite: true,
    })
    expect(r.passwordCleared).toBe(true)
    expect(await fileStore().read('trade')).toBeNull()
  })

  it('keeps the stored password on a passwordless overwrite that does not change the auth target', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', password: 'pw' })
    const r = await upsertConnection({ ...base, dataDir: dir, name: 'trade', serverTimezone: 'UTC', overwrite: true })
    expect(r.passwordCleared).toBeUndefined()
    expect(await fileStore().read('trade')).toEqual({ password: 'pw', source: 'file' })
  })
})

describe('removeConnection', () => {
  it('removes the config and the stored password', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade', password: 'pw' })
    expect(await removeConnection({ dataDir: dir, name: 'trade', insecure: true })).toBe(true)
    expect(loadConfig(dir).connections.trade).toBeUndefined()
    expect(await fileStore().read('trade')).toBeNull()
  })

  it('returns false for an unknown connection', async () => {
    expect(await removeConnection({ dataDir: dir, name: 'nope', insecure: true })).toBe(false)
  })
})

describe('assertAddable', () => {
  it('throws on a duplicate without overwrite, passes with overwrite or when absent', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'trade' })
    expect(() => assertAddable(dir, 'trade', false)).toThrow(/already exists/)
    expect(() => assertAddable(dir, 'trade', true)).not.toThrow()
    expect(() => assertAddable(dir, 'fresh', false)).not.toThrow()
  })

  it('rejects an invalid name before any existence check', () => {
    expect(() => assertAddable(dir, 'Валюта', false)).toThrow(/Invalid connection name/)
  })

  it('throws on a password-env-var collision before any verify (preflight)', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'tvip-trade', password: 'pw' })
    expect(() => assertAddable(dir, 'tvip_trade', false)).toThrow(/collides/)
  })
})

describe('concurrent mutations', () => {
  it('serializes a parallel upsert + remove without losing the new connection', async () => {
    await upsertConnection({ ...base, dataDir: dir, name: 'a' })
    await Promise.all([
      upsertConnection({ ...base, dataDir: dir, name: 'b' }),
      removeConnection({ dataDir: dir, name: 'a', insecure: true }),
    ])
    const conns = loadConfig(dir).connections
    expect(conns.a).toBeUndefined()
    expect(conns.b).toBeDefined()
  })
})
