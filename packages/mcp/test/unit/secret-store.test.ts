import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** A person's connection as stored before #272: its password keyed `<name>`. */
const PERSON = NAME_KEY_OWNER

import { keychainServiceName, NAME_KEY_OWNER, passwordEnvVar, SecretStore } from '../../src/secret-store.js'

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
    expect(await store.read('trade', PERSON)).toEqual({ password: 's3cret', source: 'env' })
    expect(await store.source('trade', PERSON)).toBe('env')
  })

  it('writes to the file backend, reads it back, then removes it', async () => {
    const store = fileStore()
    expect(await store.write('trade', 'pw', PERSON)).toEqual({ backend: 'file' })
    expect(await store.read('trade', PERSON)).toEqual({ password: 'pw', source: 'file' })
    expect(await store.source('trade', PERSON)).toBe('file')

    await store.remove('trade', PERSON)
    expect(await store.read('trade', PERSON)).toBeNull()
    expect(await store.source('trade', PERSON)).toBe('none')
  })

  it('lets env override a stored file password', async () => {
    await fileStore().write('trade', 'file-pw', PERSON)
    const store = fileStore({ ONEC_TRADE_PASSWORD: 'env-pw' })
    expect(await store.read('trade', PERSON)).toEqual({ password: 'env-pw', source: 'env' })
  })

  it('writes credentials.json with 0600 permissions', async () => {
    await fileStore().write('trade', 'pw', PERSON)
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'credentials.json')).mode & 0o777).toBe(0o600)
    }
  })

  it('refuses to read a too-open credentials file', async () => {
    const store = fileStore()
    await store.write('trade', 'pw', PERSON)
    if (process.platform !== 'win32') {
      chmodSync(join(dir, 'credentials.json'), 0o644)
      await expect(store.read('trade', PERSON)).rejects.toThrow(/insecure permissions/)
    }
  })

  it('keeps other connections when removing one', async () => {
    const store = fileStore()
    await store.write('trade', 'a', PERSON)
    await store.write('bp', 'b', PERSON)
    await store.remove('trade', PERSON)
    expect(await store.read('trade', PERSON)).toBeNull()
    expect(await store.read('bp', PERSON)).toEqual({ password: 'b', source: 'file' })
  })

  it('re-secures and preserves entries when writing over a too-open file', async () => {
    if (process.platform === 'win32') return
    const store = fileStore()
    await store.write('a', 'pw-a', PERSON)
    chmodSync(join(dir, 'credentials.json'), 0o644)
    await store.write('b', 'pw-b', PERSON) // must not throw despite the too-open file
    expect(statSync(join(dir, 'credentials.json')).mode & 0o777).toBe(0o600)
    expect(await store.read('a', PERSON)).toEqual({ password: 'pw-a', source: 'file' })
    expect(await store.read('b', PERSON)).toEqual({ password: 'pw-b', source: 'file' })
  })

  it('ignores non-string values in a hand-edited credentials file', async () => {
    const store = fileStore()
    await store.write('a', 'pw', PERSON)
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ a: 'pw', b: 123 }), { mode: 0o600 })
    expect(await store.read('b', PERSON)).toBeNull()
    expect(await store.read('a', PERSON)).toEqual({ password: 'pw', source: 'file' })
  })

  it('leaves a malformed credentials file as it is on delete, and says so (#271)', async () => {
    const store = fileStore()
    // It may hold the newest password of every other connection (#257): dropped whole, older keychain
    // copies would come out in their place. A person fixes or deletes it.
    const broken = "{ broken: 'not json"
    writeFileSync(join(dir, 'credentials.json'), broken, { mode: 0o600 })
    await expect(store.remove('trade', PERSON)).rejects.toThrow(
      /Could not remove a password from .*credentials\.json: Malformed JSON.*Nothing was deleted from it/,
    )
    expect(readFileSync(join(dir, 'credentials.json'), 'utf8')).toBe(broken)
  })

  it('a keychain write over a malformed credentials file fails rather than drop it (#271)', async () => {
    const broken = "{ broken: 'not json"
    writeFileSync(join(dir, 'credentials.json'), broken, { mode: 0o600 })
    await expect(new SecretStore({ dataDir: dir, warn: () => {} }).write('trade', 'pw', PERSON)).rejects.toThrow(
      /Nothing was deleted from it/,
    )
    expect(readFileSync(join(dir, 'credentials.json'), 'utf8')).toBe(broken)
  })

  it('a delete of a key the file does not hold leaves it untouched', async () => {
    const store = fileStore()
    await store.write('other', 'pw', PERSON)
    const before = readFileSync(join(dir, 'credentials.json'), 'utf8')
    await store.remove('trade', PERSON)
    expect(readFileSync(join(dir, 'credentials.json'), 'utf8')).toBe(before)
  })

  it('refuses to write over a malformed credentials file (no silent loss of siblings)', async () => {
    const store = fileStore()
    // Writing must NOT clobber a file whose other (unparseable) entries we can't
    // read — fail loudly so the user fixes it instead of losing passwords.
    writeFileSync(join(dir, 'credentials.json'), "{ broken: 'not json", { mode: 0o600 })
    await expect(store.write('trade', 'pw', PERSON)).rejects.toThrow(/Malformed JSON/)
  })
})

describe('keychainServiceName', () => {
  it('is "1c-odata:<basename>:<8 hex>" and stable for the same dir', () => {
    const service = keychainServiceName('/data/a')
    expect(service).toMatch(/^1c-odata:a:[0-9a-f]{8}$/)
    expect(keychainServiceName('/data/a')).toBe(service)
  })

  it('embeds the data-dir basename as a human-readable hint', () => {
    expect(keychainServiceName('/work/projB/.onec')).toMatch(/^1c-odata:\.onec:[0-9a-f]{8}$/)
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
    expect(await store.write('trade', 'pw', PERSON)).toEqual({ backend: 'keychain' })
    expect(await store.read('trade', PERSON)).toEqual({ password: 'pw', source: 'keychain' })
    expect(await store.source('trade', PERSON)).toBe('keychain')
  })

  it('isolates the same connection name across different data dirs (the fix)', async () => {
    const dirB = mkdtempSync(join(tmpdir(), 'mcp-secret-b-'))
    try {
      // env: {} keeps the test off process.env, where a real ONEC_TRADE_PASSWORD
      // would otherwise outrank the mocked keychain and mask the isolation check.
      const a = new SecretStore({ dataDir: dir, insecure: false, env: {}, warn: () => {} })
      const b = new SecretStore({ dataDir: dirB, insecure: false, env: {}, warn: () => {} })
      await a.write('trade', 'pw-a', PERSON)
      await b.write('trade', 'pw-b', PERSON)
      expect(await a.read('trade', PERSON)).toEqual({ password: 'pw-a', source: 'keychain' })
      expect(await b.read('trade', PERSON)).toEqual({ password: 'pw-b', source: 'keychain' })
    } finally {
      rmSync(dirB, { recursive: true, force: true })
    }
  })

  it('shares a secret between two stores on the SAME data dir', async () => {
    await keychainStore().write('trade', 'pw', PERSON)
    expect(await keychainStore().read('trade', PERSON)).toEqual({ password: 'pw', source: 'keychain' })
  })

  it('does not resolve a pre-namespacing flat-service entry (no migration)', async () => {
    keychain.set(keychainKey('1c-odata', 'trade'), 'old-pw') // legacy flat-service entry
    expect(await keychainStore().read('trade', PERSON)).toBeNull()
    expect(await keychainStore().source('trade', PERSON)).toBe('none')
  })

  it('lets env override a stored keychain password', async () => {
    await keychainStore().write('trade', 'kc-pw', PERSON)
    const store = keychainStore({ ONEC_TRADE_PASSWORD: 'env-pw' })
    expect(await store.read('trade', PERSON)).toEqual({ password: 'env-pw', source: 'env' })
  })

  it('removes a keychain secret', async () => {
    const store = keychainStore()
    await store.write('trade', 'pw', PERSON)
    await store.remove('trade', PERSON)
    expect(await store.read('trade', PERSON)).toBeNull()
    expect(await store.source('trade', PERSON)).toBe('none')
  })

  it('prefers the keychain on write and drops a stale file copy', async () => {
    await fileStore().write('trade', 'file-pw', PERSON) // pre-existing file secret
    const store = keychainStore()
    expect(await store.write('trade', 'kc-pw', PERSON)).toEqual({ backend: 'keychain' })
    expect(await store.read('trade', PERSON)).toEqual({ password: 'kc-pw', source: 'keychain' })
    // The stale file copy must be gone so a later insecure read can't surface it.
    expect(existsSync(join(dir, 'credentials.json'))).toBe(false)
  })
})
