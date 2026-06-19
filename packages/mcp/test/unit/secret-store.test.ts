import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { keychainServiceName, passwordEnvVar, SecretStore } from '../../src/secret-store.js'

// Isolate from the real OS keychain with an in-memory stand-in keyed by
// (service, account): best-effort keychain ops in write()/remove() must never
// touch the developer's actual keychain, and the keychain-backend tests below
// assert the per-data-dir service scheme against this deterministic store.
const { keychain } = vi.hoisted(() => ({ keychain: new Map<string, string>() }))
const keychainKey = (service: string, account: string) => JSON.stringify([service, account])
vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    constructor(
      private readonly service: string,
      private readonly account: string,
    ) {}
    getPassword(): string | null {
      return keychain.get(keychainKey(this.service, this.account)) ?? null
    }
    setPassword(password: string): void {
      keychain.set(keychainKey(this.service, this.account), password)
    }
    deletePassword(): boolean {
      return keychain.delete(keychainKey(this.service, this.account))
    }
  },
}))

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-secret-'))
  keychain.clear()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// insecure: true keeps tests off the real OS keychain (which is also
// unavailable on headless CI) — the file backend is fully deterministic.
const fileStore = (env: NodeJS.ProcessEnv = {}) =>
  new SecretStore({ dataDir: dir, insecure: true, env, warn: () => {} })

// insecure: false routes through the mocked keychain (vi.mock above), exercising
// the per-data-dir service scheme without the real OS keychain.
const keychainStore = (env: NodeJS.ProcessEnv = {}) =>
  new SecretStore({ dataDir: dir, insecure: false, env, warn: () => {} })

describe('passwordEnvVar', () => {
  it('uppercases and slugifies the connection name', () => {
    expect(passwordEnvVar('tvip-trade')).toBe('ONEC_TVIP_TRADE_PASSWORD')
    expect(passwordEnvVar('bp v3.0')).toBe('ONEC_BP_V3_0_PASSWORD')
  })
})

describe('SecretStore', () => {
  it('reads the password from env with highest priority', async () => {
    const store = fileStore({ ONEC_TRADE_PASSWORD: 's3cret' })
    expect(await store.read('trade')).toEqual({ password: 's3cret', source: 'env' })
    expect(await store.source('trade')).toBe('env')
  })

  it('writes to the file backend, reads it back, then removes it', async () => {
    const store = fileStore()
    expect(await store.write('trade', 'pw')).toEqual({ backend: 'file' })
    expect(await store.read('trade')).toEqual({ password: 'pw', source: 'file' })
    expect(await store.source('trade')).toBe('file')

    await store.remove('trade')
    expect(await store.read('trade')).toBeNull()
    expect(await store.source('trade')).toBe('none')
  })

  it('lets env override a stored file password', async () => {
    await fileStore().write('trade', 'file-pw')
    const store = fileStore({ ONEC_TRADE_PASSWORD: 'env-pw' })
    expect(await store.read('trade')).toEqual({ password: 'env-pw', source: 'env' })
  })

  it('writes credentials.json with 0600 permissions', async () => {
    await fileStore().write('trade', 'pw')
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'credentials.json')).mode & 0o777).toBe(0o600)
    }
  })

  it('refuses to read a too-open credentials file', async () => {
    const store = fileStore()
    await store.write('trade', 'pw')
    if (process.platform !== 'win32') {
      chmodSync(join(dir, 'credentials.json'), 0o644)
      await expect(store.read('trade')).rejects.toThrow(/insecure permissions/)
    }
  })

  it('keeps other connections when removing one', async () => {
    const store = fileStore()
    await store.write('trade', 'a')
    await store.write('bp', 'b')
    await store.remove('trade')
    expect(await store.read('trade')).toBeNull()
    expect(await store.read('bp')).toEqual({ password: 'b', source: 'file' })
  })

  it('re-secures and preserves entries when writing over a too-open file', async () => {
    if (process.platform === 'win32') return
    const store = fileStore()
    await store.write('a', 'pw-a')
    chmodSync(join(dir, 'credentials.json'), 0o644)
    await store.write('b', 'pw-b') // must not throw despite the too-open file
    expect(statSync(join(dir, 'credentials.json')).mode & 0o777).toBe(0o600)
    expect(await store.read('a')).toEqual({ password: 'pw-a', source: 'file' })
    expect(await store.read('b')).toEqual({ password: 'pw-b', source: 'file' })
  })

  it('ignores non-string values in a hand-edited credentials file', async () => {
    const store = fileStore()
    await store.write('a', 'pw')
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ a: 'pw', b: 123 }), { mode: 0o600 })
    expect(await store.read('b')).toBeNull()
    expect(await store.read('a')).toEqual({ password: 'pw', source: 'file' })
  })

  it('removes a malformed credentials file on delete, leaving no stale plaintext', async () => {
    const store = fileStore()
    // A hand-broken file our parser can't read must still be cleared on remove,
    // not left on disk (it may hold plaintext we couldn't parse).
    writeFileSync(join(dir, 'credentials.json'), "{ broken: 'not json", { mode: 0o600 })
    await store.remove('trade')
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false)
  })

  it('refuses to write over a malformed credentials file (no silent loss of siblings)', async () => {
    const store = fileStore()
    // Writing must NOT clobber a file whose other (unparseable) entries we can't
    // read — fail loudly so the user fixes it instead of losing passwords.
    writeFileSync(join(dir, 'credentials.json'), "{ broken: 'not json", { mode: 0o600 })
    await expect(store.write('trade', 'pw')).rejects.toThrow(/Malformed JSON/)
  })
})

describe('keychainServiceName', () => {
  it('is "1c-odata:<16 hex>" and stable for the same dir', () => {
    const service = keychainServiceName('/data/a')
    expect(service).toMatch(/^1c-odata:[0-9a-f]{16}$/)
    expect(keychainServiceName('/data/a')).toBe(service)
  })

  it('isolates different dirs but canonicalizes trailing slash and "." / ".."', () => {
    expect(keychainServiceName('/data/a')).not.toBe(keychainServiceName('/data/b'))
    expect(keychainServiceName('/data/a/')).toBe(keychainServiceName('/data/a'))
    expect(keychainServiceName('/data/x/../a')).toBe(keychainServiceName('/data/a'))
  })
})

describe('SecretStore keychain backend', () => {
  it('writes to and reads back from the keychain', async () => {
    const store = keychainStore()
    expect(await store.write('trade', 'pw')).toEqual({ backend: 'keychain' })
    expect(await store.read('trade')).toEqual({ password: 'pw', source: 'keychain' })
    expect(await store.source('trade')).toBe('keychain')
  })

  it('isolates the same connection name across different data dirs (the fix)', async () => {
    const dirB = mkdtempSync(join(tmpdir(), 'mcp-secret-b-'))
    try {
      // env: {} keeps the test off process.env, where a real ONEC_TRADE_PASSWORD
      // would otherwise outrank the mocked keychain and mask the isolation check.
      const a = new SecretStore({ dataDir: dir, insecure: false, env: {}, warn: () => {} })
      const b = new SecretStore({ dataDir: dirB, insecure: false, env: {}, warn: () => {} })
      await a.write('trade', 'pw-a')
      await b.write('trade', 'pw-b')
      expect(await a.read('trade')).toEqual({ password: 'pw-a', source: 'keychain' })
      expect(await b.read('trade')).toEqual({ password: 'pw-b', source: 'keychain' })
    } finally {
      rmSync(dirB, { recursive: true, force: true })
    }
  })

  it('shares a secret between two stores on the SAME data dir', async () => {
    await keychainStore().write('trade', 'pw')
    expect(await keychainStore().read('trade')).toEqual({ password: 'pw', source: 'keychain' })
  })

  it('does not resolve a pre-namespacing flat-service entry (no migration)', async () => {
    keychain.set(keychainKey('1c-odata', 'trade'), 'old-pw') // legacy flat-service entry
    expect(await keychainStore().read('trade')).toBeNull()
    expect(await keychainStore().source('trade')).toBe('none')
  })

  it('lets env override a stored keychain password', async () => {
    await keychainStore().write('trade', 'kc-pw')
    const store = keychainStore({ ONEC_TRADE_PASSWORD: 'env-pw' })
    expect(await store.read('trade')).toEqual({ password: 'env-pw', source: 'env' })
  })

  it('removes a keychain secret', async () => {
    const store = keychainStore()
    await store.write('trade', 'pw')
    await store.remove('trade')
    expect(await store.read('trade')).toBeNull()
    expect(await store.source('trade')).toBe('none')
  })

  it('prefers the keychain on write and drops a stale file copy', async () => {
    await fileStore().write('trade', 'file-pw') // pre-existing file secret
    const store = keychainStore()
    expect(await store.write('trade', 'kc-pw')).toEqual({ backend: 'keychain' })
    expect(await store.read('trade')).toEqual({ password: 'kc-pw', source: 'keychain' })
    // The stale file copy must be gone so a later insecure read can't surface it.
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false)
  })
})
