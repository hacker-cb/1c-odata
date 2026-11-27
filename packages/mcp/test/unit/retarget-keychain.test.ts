import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, saveConfig } from '../../src/config.js'
import { removeConnection, updateConnectionCredentials, upsertConnection } from '../../src/connections.js'
import { FileConnectionSource } from '../../src/file-connection-source.js'
import { keychainServiceName, SecretStore, secretKey } from '../../src/secret-store.js'

/** The keychain as the tests set it: what deleting an entry does, and the entries it holds. */
const keychain = vi.hoisted(() => ({
  deleteFails: false,
  setFails: false,
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
      if (keychain.setFails) throw new Error('Platform secure storage failure: keychain locked')
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
  keychain.setFails = false
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

describe('a password written while the keychain cannot store it (#257)', () => {
  const keychainKey = () => `${keychainServiceName(dir)}/c`
  /** `c` holds an old password in the keychain; then the keychain stops taking writes and deletes. */
  const lockKeychainOverOldPassword = () => {
    keychain.entries.set(keychainKey(), 'old')
    keychain.setFails = true
    keychain.deleteFails = true
  }
  const unlockKeychain = () => {
    keychain.setFails = false
    keychain.deleteFails = false
  }

  const writeNew = (insecure = false) =>
    upsertConnection({
      dataDir: dir,
      name: 'c',
      baseUrl: NEW,
      login: 'u',
      serverTimezone: 'Europe/Moscow',
      password: 'new',
      insecure,
      overwrite: true,
    })

  it('falls back to the file, which outranks the old keychain copy once the keychain answers again', async () => {
    lockKeychainOverOldPassword()
    await expect(writeNew()).resolves.toMatchObject({ passwordBackend: 'file' })
    expect(loadConfig(dir).connections.c?.baseUrl).toBe(NEW)
    unlockKeychain()
    expect(keychain.entries.get(keychainKey())).toBe('old')
    expect(await new SecretStore({ dataDir: dir }).read('c')).toEqual({ password: 'new', source: 'file' })
    expect(await new SecretStore({ dataDir: dir }).source('c')).toBe('file')
  })

  it('on a host without a working keychain (set and delete fail alike, nothing stored) the password goes to the file', async () => {
    keychain.setFails = true
    keychain.deleteFails = true
    await expect(writeNew()).resolves.toMatchObject({ passwordBackend: 'file' })
    expect(await new SecretStore({ dataDir: dir }).read('c')).toEqual({ password: 'new', source: 'file' })
  })

  it('a file written under --insecure-storage outranks the keychain copy for a process that reads the keychain', async () => {
    keychain.entries.set(keychainKey(), 'old')
    keychain.deleteFails = true
    await expect(writeNew(true)).resolves.toMatchObject({ passwordBackend: 'file' })
    expect(await new SecretStore({ dataDir: dir }).read('c')).toEqual({ password: 'new', source: 'file' })
  })

  it('drops the old keychain copy where it can', async () => {
    keychain.entries.set(keychainKey(), 'old')
    keychain.setFails = true
    await expect(writeNew()).resolves.toMatchObject({ passwordBackend: 'file' })
    expect(keychain.entries.has(keychainKey())).toBe(false)
  })

  it('a keychain write takes the file copy away: the newest password is the keychain one', async () => {
    keychain.setFails = true
    await writeNew()
    keychain.setFails = false
    await upsertConnection({
      dataDir: dir,
      name: 'c',
      baseUrl: NEW,
      login: 'u',
      serverTimezone: 'Europe/Moscow',
      password: 'newer',
      overwrite: true,
    })
    expect(await new SecretStore({ dataDir: dir }).read('c')).toEqual({ password: 'newer', source: 'keychain' })
  })

  it.skipIf(process.platform === 'win32')(
    'a file write that fails loses nothing: the keychain copy stays, the config keeps its target',
    async () => {
      keychain.entries.set(keychainKey(), 'old')
      keychain.setFails = true
      chmodSync(dir, 0o500)
      try {
        await expect(writeNew()).rejects.toThrow()
      } finally {
        chmodSync(dir, 0o700)
      }
      keychain.setFails = false
      expect(loadConfig(dir).connections.c?.baseUrl).toBe(OLD)
      expect(await new SecretStore({ dataDir: dir }).read('c')).toEqual({ password: 'old', source: 'keychain' })
    },
  )
})

describe('an agent’s connection reads only a password stored for its own target (#253)', () => {
  const EVIL = 'http://agent.test/odata/standard.odata'
  const source = () => new FileConnectionSource({ dataDir: dir })
  /** The password connection `c` resolves to, as a process building a client reads it. */
  const resolved = async () => (await source().getSecret('c')) ?? null

  const agentAdds = (baseUrl: string, password?: string) =>
    upsertConnection({
      dataDir: dir,
      name: 'c',
      baseUrl,
      login: 'u',
      serverTimezone: 'Europe/Moscow',
      byAgent: true,
      ...(password !== undefined ? { password } : {}),
    })

  beforeEach(async () => {
    // A person's `c` with its password in the keychain.
    await upsertConnection({
      dataDir: dir,
      name: 'c',
      baseUrl: OLD,
      login: 'u',
      serverTimezone: 'Europe/Moscow',
      password: 'persons',
      overwrite: true,
    })
    expect(await resolved()).toBe('persons')
  })

  it.each([
    ['another server', EVIL],
    ['the same server', OLD],
  ])(
    're-created by an agent on %s after a remove that could not delete the keychain copy: no password',
    async (_what, url) => {
      keychain.deleteFails = true
      expect(await removeConnection({ dataDir: dir, name: 'c' })).toBe(true)
      keychain.deleteFails = false
      // The person's password is still in the keychain, under the name.
      expect(keychain.entries.get(`${keychainServiceName(dir)}/c`)).toBe('persons')
      await agentAdds(url)
      expect(loadConfig(dir).connections.c).toMatchObject({ baseUrl: url, addedBy: 'agent' })
      expect(await resolved()).toBeNull()
      expect(await new SecretStore({ dataDir: dir }).source('c', loadConfig(dir).connections.c)).toBe('none')
    },
  )

  it('the agent’s own password is stored under its target and read back; the person’s stays apart', async () => {
    await removeConnection({ dataDir: dir, name: 'c' })
    await agentAdds(EVIL, 'agents')
    const conn = loadConfig(dir).connections.c
    expect(secretKey('c', conn)).toMatch(/^c@[0-9a-f]{16}$/)
    expect(keychain.entries.get(`${keychainServiceName(dir)}/${secretKey('c', conn)}`)).toBe('agents')
    expect(await resolved()).toBe('agents')
  })

  it('a login change of the agent’s connection (set_credentials) keeps its password: the key is the server alone', async () => {
    await removeConnection({ dataDir: dir, name: 'c' })
    await agentAdds(EVIL, 'agents')
    await updateConnectionCredentials({ dataDir: dir, name: 'c', login: 'u2' })
    expect(loadConfig(dir).connections.c).toMatchObject({ login: 'u2', addedBy: 'agent' })
    expect(await resolved()).toBe('agents')
  })

  it('the key reads the base URL as a target: a trailing slash or userinfo is the same key', () => {
    const agent = (baseUrl: string) => secretKey('c', { baseUrl, addedBy: 'agent' })
    expect(agent(`${EVIL}/`)).toBe(agent(EVIL))
    expect(agent(' http://x:y@agent.test/odata/standard.odata ')).toBe(agent(EVIL))
    expect(agent(OLD)).not.toBe(agent(EVIL))
    expect(secretKey('c', { baseUrl: EVIL })).toBe('c')
  })

  it('a person re-adding the agent’s target without a password clears what the agent stored, and leaves no stale one of theirs', async () => {
    keychain.deleteFails = true
    await removeConnection({ dataDir: dir, name: 'c' })
    keychain.deleteFails = false
    await agentAdds(EVIL, 'agents')
    // The person's old password (for OLD) is still under the name; re-adding EVIL must not send it there.
    const result = await upsertConnection({
      dataDir: dir,
      name: 'c',
      baseUrl: EVIL,
      login: 'u',
      serverTimezone: 'Europe/Moscow',
      overwrite: true,
    })
    expect(result.passwordCleared).toBe(true)
    expect(loadConfig(dir).connections.c?.addedBy).toBeUndefined()
    expect(await resolved()).toBeNull()
    expect([...keychain.entries.keys()]).toEqual([])
  })

  it('remove_connection of an agent’s connection deletes its password under the target', async () => {
    await removeConnection({ dataDir: dir, name: 'c' })
    await agentAdds(EVIL, 'agents')
    await removeConnection({ dataDir: dir, name: 'c' })
    expect([...keychain.entries.keys()]).toEqual([])
  })
})
