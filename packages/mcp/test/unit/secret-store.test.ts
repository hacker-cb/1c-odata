import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { passwordEnvVar, SecretStore } from '../../src/secret-store.js'

// Isolate from the real OS keychain: best-effort keychain deletes (write/remove)
// must not touch the developer's actual keychain during unit tests.
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
  dir = mkdtempSync(join(tmpdir(), 'mcp-secret-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// insecure: true keeps tests off the real OS keychain (which is also
// unavailable on headless CI) — the file backend is fully deterministic.
const fileStore = (env: NodeJS.ProcessEnv = {}) =>
  new SecretStore({ dataDir: dir, insecure: true, env, warn: () => {} })

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
})
