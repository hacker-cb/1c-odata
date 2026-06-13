import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { removeConnection, upsertConnection } from '../../src/connections.js'
import { SecretStore } from '../../src/secret-store.js'

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

  it('saves config only when no password is given', async () => {
    const result = await upsertConnection({ ...base, dataDir: dir, name: 'trade' })
    expect(result.passwordBackend).toBeUndefined()
    expect(loadConfig(dir).connections.trade?.login).toBe('u')
    expect(await fileStore().read('trade')).toBeNull()
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
