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
  /** Runs as a password is set — under the data-dir lock, so a test can break the dir after the lock is taken. */
  onSet: undefined as (() => void) | undefined,
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
      keychain.onSet?.()
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
  keychain.onSet = undefined
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

describe('re-pointing a connection without a password (#270, #272)', () => {
  /** `c` as written before #272: its password in the keychain under the bare name. */
  const nameKey = () => `${keychainServiceName(dir)}/c`
  beforeEach(() => {
    keychain.entries.set(nameKey(), 'old')
  })

  it('a connection still keyed <name> refuses where the keychain cannot delete it — older versions read <name> whatever the target', async () => {
    keychain.deleteFails = true
    await expect(retarget(false)).rejects.toThrow(/Could not delete the stored password of "c".*nothing was changed/)
    // Saved, then put back once the delete failed: the connection is as it was, password included.
    expect(loadConfig(dir).connections.c).toEqual({ baseUrl: OLD, login: 'u', serverTimezone: 'Europe/Moscow' })
    expect(await new SecretStore({ dataDir: dir }).read('c', loadConfig(dir).connections.c)).toEqual({
      password: 'old',
      source: 'keychain',
    })
  })

  it('a connection keyed to its target re-points even where the keychain cannot delete: the old copy stays its own', async () => {
    keychain.entries.clear()
    await upsertConnection({ dataDir: dir, name: 'c', baseUrl: OLD, login: 'u', password: 'old', overwrite: true })
    const oldKey = `${keychainServiceName(dir)}/${secretKey('c', { baseUrl: OLD, passwordKey: 'target' })}`
    expect(keychain.entries.get(oldKey)).toBe('old')
    keychain.deleteFails = true
    await expect(retarget(false)).resolves.toMatchObject({ passwordCleared: true })
    const conn = loadConfig(dir).connections.c
    expect(conn).toMatchObject({ baseUrl: NEW, passwordKey: 'target' })
    expect(await new SecretStore({ dataDir: dir }).read('c', conn)).toBeNull()
    expect(keychain.entries.get(oldKey)).toBe('old') // left under OLD's key, which only OLD reads
  })

  it('a login change on the same server without a password clears the password — strictly, the key being the same', async () => {
    keychain.entries.clear()
    await upsertConnection({ dataDir: dir, name: 'c', baseUrl: OLD, login: 'u', password: 'alice', overwrite: true })
    const relogin = () => upsertConnection({ dataDir: dir, name: 'c', baseUrl: OLD, login: 'bob', overwrite: true })
    keychain.deleteFails = true
    await expect(relogin()).rejects.toThrow(/Could not delete the stored password of "c"/)
    expect(loadConfig(dir).connections.c?.login).toBe('u')
    keychain.deleteFails = false
    await expect(relogin()).resolves.toMatchObject({ passwordCleared: true })
    expect(await new SecretStore({ dataDir: dir }).read('c', loadConfig(dir).connections.c)).toBeNull()
  })

  it('drops the old target’s password once the config no longer reads it', async () => {
    await expect(retarget(false)).resolves.toMatchObject({ passwordCleared: true })
    expect(keychain.entries.has(nameKey())).toBe(false)
  })

  it('under --insecure-storage too', async () => {
    keychain.deleteFails = true
    await expect(retarget(true)).resolves.toMatchObject({ passwordCleared: true })
    expect(await new SecretStore({ dataDir: dir }).read('c', loadConfig(dir).connections.c)).toBeNull()
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
    expect(await new SecretStore({ dataDir: dir }).read('c', loadConfig(dir).connections['c'])).toEqual({
      password: 'new',
      source: 'file',
    })
    expect(await new SecretStore({ dataDir: dir }).source('c', loadConfig(dir).connections['c'])).toBe('file')
  })

  it('on a host without a working keychain (set and delete fail alike, nothing stored) the password goes to the file', async () => {
    keychain.setFails = true
    keychain.deleteFails = true
    await expect(writeNew()).resolves.toMatchObject({ passwordBackend: 'file' })
    expect(await new SecretStore({ dataDir: dir }).read('c', loadConfig(dir).connections['c'])).toEqual({
      password: 'new',
      source: 'file',
    })
  })

  it('a file written under --insecure-storage outranks the keychain copy for a process that reads the keychain', async () => {
    keychain.entries.set(keychainKey(), 'old')
    keychain.deleteFails = true
    await expect(writeNew(true)).resolves.toMatchObject({ passwordBackend: 'file' })
    expect(await new SecretStore({ dataDir: dir }).read('c', loadConfig(dir).connections['c'])).toEqual({
      password: 'new',
      source: 'file',
    })
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
    expect(await new SecretStore({ dataDir: dir }).read('c', loadConfig(dir).connections['c'])).toEqual({
      password: 'newer',
      source: 'keychain',
    })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a keychain write whose file copy cannot be deleted fails, and the old password stays the one read',
    async () => {
      keychain.setFails = true
      await writeNew() // an earlier fallback: 'new' in the file, the config at NEW
      keychain.setFails = false
      // Read-only once the write holds the lock: the keychain takes it, the file copy cannot be deleted.
      keychain.onSet = () => chmodSync(dir, 0o500)
      try {
        await expect(
          upsertConnection({
            dataDir: dir,
            name: 'c',
            baseUrl: NEW,
            login: 'u',
            serverTimezone: 'Europe/Moscow',
            password: 'newer',
            overwrite: true,
          }),
        ).rejects.toThrow(/EACCES.*credentials\.json/)
      } finally {
        chmodSync(dir, 0o700)
      }
      // The write failed as a whole: the config keeps its target, which still reads its own password.
      expect(loadConfig(dir).connections.c?.baseUrl).toBe(NEW)
      expect(await new SecretStore({ dataDir: dir }).read('c', loadConfig(dir).connections['c'])).toEqual({
        password: 'new',
        source: 'file',
      })
    },
  )

  // A mode-0500 directory refuses the write only where permissions bind: not on Windows, not for root.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a file write that fails loses nothing: the keychain copy stays, the config keeps its target',
    async () => {
      keychain.entries.set(keychainKey(), 'old')
      keychain.setFails = true
      // Read-only once the write holds the lock: the keychain refuses, and so does the file fallback.
      keychain.onSet = () => chmodSync(dir, 0o500)
      try {
        await expect(writeNew()).rejects.toThrow(/EACCES.*credentials\.json/)
      } finally {
        chmodSync(dir, 0o700)
      }
      keychain.setFails = false
      expect(loadConfig(dir).connections.c?.baseUrl).toBe(OLD)
      expect(await new SecretStore({ dataDir: dir }).read('c', loadConfig(dir).connections['c'])).toEqual({
        password: 'old',
        source: 'keychain',
      })
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

  /** The key a person's connection `c` on `baseUrl` keeps its password under (#272). */
  const personKey = (baseUrl: string) => secretKey('c', { baseUrl, passwordKey: 'target' })

  it.each([
    ['another server', EVIL],
    ['the same server', OLD],
  ])(
    're-created by an agent on %s after a remove that could not delete the keychain copy: no password',
    async (_what, url) => {
      keychain.deleteFails = true
      expect(await removeConnection({ dataDir: dir, name: 'c' })).toBe(true)
      keychain.deleteFails = false
      // The person's password is still in the keychain, under the person's key for OLD.
      expect(keychain.entries.get(`${keychainServiceName(dir)}/${personKey(OLD)}`)).toBe('persons')
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
    if (conn === undefined) throw new Error('c missing')
    expect(secretKey('c', conn)).toMatch(/^c@[0-9a-f]{16}$/)
    expect(keychain.entries.get(`${keychainServiceName(dir)}/${secretKey('c', conn)}`)).toBe('agents')
    expect(await resolved()).toBe('agents')
  })

  it('a login change of the agent’s connection (set_credentials) keeps its password: the key is the server alone', async () => {
    await removeConnection({ dataDir: dir, name: 'c' })
    await agentAdds(EVIL, 'agents')
    await updateConnectionCredentials({ expected: { baseUrl: EVIL, login: 'u' }, dataDir: dir, name: 'c', login: 'u2' })
    expect(loadConfig(dir).connections.c).toMatchObject({ login: 'u2', addedBy: 'agent' })
    expect(await resolved()).toBe('agents')
  })

  it('the key reads the base URL as a target: a trailing slash or userinfo is the same key', () => {
    const agent = (baseUrl: string) => secretKey('c', { baseUrl, addedBy: 'agent' })
    expect(agent(`${EVIL}/`)).toBe(agent(EVIL))
    expect(agent(' http://x:y@agent.test/odata/standard.odata ')).toBe(agent(EVIL))
    expect(agent(OLD)).not.toBe(agent(EVIL))
    expect(secretKey('c', { baseUrl: EVIL })).toBe('c')
    expect(personKey(`${EVIL}/`)).toBe(personKey(EVIL))
    expect(personKey(EVIL)).toMatch(/^c\+[0-9a-f]{16}$/)
    expect(personKey(EVIL).slice(2)).toBe(agent(EVIL).slice(2)) // one hash, two forms
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
    // The agent's is gone; the person's old one stays keyed to OLD, the only target that reads it.
    expect([...keychain.entries.keys()]).toEqual([`${keychainServiceName(dir)}/${personKey(OLD)}`])
  })

  it('remove_connection of an agent’s connection deletes its password under the target', async () => {
    await removeConnection({ dataDir: dir, name: 'c' })
    await agentAdds(EVIL, 'agents')
    await removeConnection({ dataDir: dir, name: 'c' })
    expect([...keychain.entries.keys()]).toEqual([])
  })
})
