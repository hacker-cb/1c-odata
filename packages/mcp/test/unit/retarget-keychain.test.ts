import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, saveConfig } from '../../src/config.js'
import { upsertConnection } from '../../src/connections.js'

/** The keychain as the tests set it: what deleting an entry does, and the entries it holds. */
const keychain = vi.hoisted(() => ({
  deleteFails: false,
  entries: new Map<string, string>(),
}))

vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    private readonly key: string
    constructor(service: string, account: string) {
      this.key = `${service}/${account}`
    }
    getPassword(): string | null {
      return keychain.entries.get(this.key) ?? null
    }
    setPassword(password: string): void {
      keychain.entries.set(this.key, password)
    }
    deletePassword(): boolean {
      if (keychain.deleteFails) throw new Error('Platform secure storage failure: keychain locked')
      // As measured on macOS: no entry answers false, it does not throw.
      return keychain.entries.delete(this.key)
    }
  },
}))

const OLD = 'http://old.test/odata/standard.odata'
const NEW = 'http://new.test/odata/standard.odata'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-retarget-'))
  keychain.deleteFails = false
  keychain.entries.clear()
  vi.stubEnv('ONEC_C_PASSWORD', '')
  saveConfig(dir, { connections: { c: { baseUrl: OLD, login: 'u', serverTimezone: 'Europe/Moscow' } } })
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const retarget = (insecure: boolean) =>
  upsertConnection({
    dataDir: dir,
    name: 'c',
    baseUrl: NEW,
    login: 'u',
    serverTimezone: 'Europe/Moscow',
    insecure,
    overwrite: true,
  })

describe('re-pointing a connection fails closed on a keychain that cannot delete its password', () => {
  it('refuses, and the config keeps the old target, where the keychain delete errors', async () => {
    keychain.deleteFails = true
    await expect(retarget(false)).rejects.toThrow(/Could not delete the stored password of "c".*nothing was changed/)
    expect(loadConfig(dir).connections.c?.baseUrl).toBe(OLD)
  })

  it('re-points, the password cleared, where the keychain has no entry', async () => {
    const result = await retarget(false)
    expect(result.passwordCleared).toBe(true)
    expect(loadConfig(dir).connections.c?.baseUrl).toBe(NEW)
  })

  it('stays best-effort under --insecure-storage, which never reads the keychain', async () => {
    keychain.deleteFails = true
    await expect(retarget(true)).resolves.toMatchObject({ passwordCleared: true })
    expect(loadConfig(dir).connections.c?.baseUrl).toBe(NEW)
  })
})
