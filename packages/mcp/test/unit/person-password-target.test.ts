import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runSetCredentials } from '../../src/commands/set-credentials.js'
import { loadConfig, type StoredConnection, saveConfig, targetBaseUrl } from '../../src/config.js'
import {
  removeConnection,
  setConnectionLabel,
  updateConnectionCredentials,
  upsertConnection,
} from '../../src/connections.js'
import { FileConnectionSource } from '../../src/file-connection-source.js'
import { keychainServiceName, NAME_KEY_OWNER, SecretStore, secretKey } from '../../src/secret-store.js'

/** The keychain as the tests set it, and what a failing config save does. */
const state = vi.hoisted(() => ({
  deleteFails: false,
  readFails: false,
  /** Runs as a password is set — between the secret write and the config save of an upsert. */
  onSet: undefined as (() => void) | undefined,
  entries: new Map<string, string>(),
  configSaveFails: false,
}))

vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    private readonly key: string
    constructor(service: string, account: string) {
      this.key = `${service}/${account}`
    }
    getPassword(): string | null {
      if (state.readFails) throw new Error('Platform secure storage failure: keychain locked')
      return state.entries.get(this.key) ?? null
    }
    setPassword(password: string): void {
      state.entries.set(this.key, password)
      state.onSet?.()
    }
    deletePassword(): boolean {
      if (state.deleteFails) throw new Error('Platform secure storage failure: keychain locked')
      return state.entries.delete(this.key)
    }
  },
}))

vi.mock('../../src/atomic-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/atomic-write.js')>()
  return {
    writeFileAtomic(path: string, content: string): void {
      if (state.configSaveFails && path.endsWith('config.json')) throw new Error('ENOSPC: no space left on device')
      actual.writeFileAtomic(path, content)
    },
  }
})

const OLD = 'http://old.test/odata/standard.odata'
const NEW = 'http://new.test/odata/standard.odata'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-person-key-'))
  state.deleteFails = false
  state.readFails = false
  state.onSet = undefined
  state.configSaveFails = false
  state.entries.clear()
  vi.stubEnv('ONEC_PROD_PASSWORD', '')
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const add = (baseUrl: string, extra: { password?: string; insecure?: boolean; overwrite?: boolean } = {}) =>
  upsertConnection({ dataDir: dir, name: 'prod', baseUrl, login: 'u', serverTimezone: 'Europe/Moscow', ...extra })

/** The password a process building a client for `prod` reads, from the config as it stands. */
const resolved = () => new FileConnectionSource({ dataDir: dir }).getSecret('prod')

/** The keychain entry of `prod` under `owner`'s key. */
const entry = (owner: Parameters<typeof secretKey>[1]) =>
  state.entries.get(`${keychainServiceName(dir)}/${secretKey('prod', owner)}`)

/**
 * What a reader building a client from `config.json` as it stands gets, at
 * this very moment: the keychain entry under the key its record names — read
 * synchronously, so nothing the write does next can come in between. The file
 * backend stays empty in these tests (the keychain takes every write).
 */
function readerSees(): string | undefined {
  const conn = loadConfig(dir).connections.prod
  if (conn === undefined) throw new Error('prod missing')
  return entry(conn)
}

/** `prod` as written before #272: a person's, no `passwordKey`, its password in the keychain under `prod`. */
function legacyProd(password = 'legacy'): StoredConnection {
  const conn: StoredConnection = { baseUrl: OLD, login: 'u', serverTimezone: 'Europe/Moscow' }
  saveConfig(dir, { connections: { prod: conn } })
  state.entries.set(`${keychainServiceName(dir)}/prod`, password)
  return conn
}

describe('a person’s password is keyed to its target (#272)', () => {
  it('a new connection is marked, and its password lives under <name>+<hash of its base URL>', async () => {
    await add(OLD, { password: 'p' })
    const conn = loadConfig(dir).connections.prod
    expect(conn?.passwordKey).toBe('target')
    if (conn === undefined) throw new Error('prod missing')
    expect(secretKey('prod', conn)).toMatch(/^prod\+[0-9a-f]{16}$/)
    expect(entry(conn)).toBe('p')
    expect(await resolved()).toBe('p')
  })

  it('path 1: removed with a locked keychain, then re-added elsewhere without a password — no password', async () => {
    await add(OLD, { password: 'old-secret' })
    state.deleteFails = true
    await removeConnection({ dataDir: dir, name: 'prod' })
    state.deleteFails = false
    await add(NEW)
    expect(await resolved()).toBeNull()
  })

  it('path 2: re-pointed without a password by an --insecure-storage process — no password for a keychain reader', async () => {
    await add(OLD, { password: 'old-secret' })
    state.deleteFails = true
    await add(NEW, { insecure: true, overwrite: true })
    state.deleteFails = false
    expect(await resolved()).toBeNull()
  })

  it('a reader of the old config, between the secret write and the config save, never gets the new password', async () => {
    await add(OLD, { password: 'old-secret' })
    const before = loadConfig(dir).connections.prod
    let midway: string | undefined
    // The new password is in the keychain; config.json still points at OLD — what a reader of it gets now.
    state.onSet = () => {
      midway ??= readerSees()
    }
    await add(NEW, { password: 'new-secret', overwrite: true })
    expect(loadConfig(dir).connections.prod?.baseUrl).toBe(NEW)
    expect(midway).toBe('old-secret')
    expect(before).toMatchObject({ baseUrl: OLD })
    expect(await resolved()).toBe('new-secret')
  })

  it('the same window on a connection still keyed <name>', async () => {
    legacyProd('old-secret')
    let midway: string | undefined
    state.onSet = () => {
      midway ??= readerSees()
    }
    await add(NEW, { password: 'new-secret', overwrite: true })
    expect(midway).toBe('old-secret')
    expect(await resolved()).toBe('new-secret')
  })

  it('an agent’s connection and a person’s never share a key on one target', () => {
    const person = secretKey('prod', { baseUrl: OLD, passwordKey: 'target' })
    const agent = secretKey('prod', { baseUrl: OLD, addedBy: 'agent' })
    expect(person).not.toBe(agent)
    expect(person.slice('prod+'.length)).toBe(agent.slice('prod@'.length))
  })

  it('config.json keeps the mark on a person’s connection only', () => {
    saveConfig(dir, {
      connections: {
        a: { baseUrl: OLD, login: 'u', serverTimezone: 'UTC', passwordKey: 'target' },
        b: { baseUrl: OLD, login: 'u', serverTimezone: 'UTC', addedBy: 'agent', passwordKey: 'target' },
        c: { baseUrl: OLD, login: 'u', serverTimezone: 'UTC', passwordKey: 'other' as 'target' },
      },
    })
    const { connections } = loadConfig(dir)
    expect(connections.a?.passwordKey).toBe('target')
    expect(connections.b?.passwordKey).toBeUndefined()
    expect(connections.c?.passwordKey).toBeUndefined()
  })
})

describe('a connection from before #272 keeps its password', () => {
  it('is read under <name> until something changes it', async () => {
    legacyProd()
    expect(await resolved()).toBe('legacy')
  })

  it('an overwrite on the same base URL without a password carries it to the target’s key', async () => {
    const legacy = legacyProd()
    await expect(
      upsertConnection({
        dataDir: dir,
        name: 'prod',
        baseUrl: `${OLD}/`,
        login: 'u',
        label: 'Прод',
        overwrite: true,
      }),
    ).resolves.toEqual({ overwritten: true })
    const conn = loadConfig(dir).connections.prod
    expect(conn).toMatchObject({ label: 'Прод', passwordKey: 'target' })
    expect(await resolved()).toBe('legacy')
    expect(entry(legacy)).toBeUndefined() // `prod` dropped once the config read the new key
  })

  it('a login-only set_credentials carries it too', async () => {
    legacyProd()
    await updateConnectionCredentials({
      dataDir: dir,
      name: 'prod',
      login: 'u2',
      expected: { baseUrl: OLD, login: 'u' },
    })
    expect(loadConfig(dir).connections.prod).toMatchObject({ login: 'u2', passwordKey: 'target' })
    expect(await resolved()).toBe('legacy')
  })

  it('a new password from set_credentials goes under the target’s key, and <name> is dropped', async () => {
    const legacy = legacyProd()
    await updateConnectionCredentials({
      dataDir: dir,
      name: 'prod',
      password: 'rotated',
      expected: { baseUrl: OLD, login: 'u' },
    })
    expect(loadConfig(dir).connections.prod?.passwordKey).toBe('target')
    expect(await resolved()).toBe('rotated')
    expect(entry(legacy)).toBeUndefined()
  })

  it('a re-point to another base URL without a password carries nothing', async () => {
    legacyProd()
    await expect(add(NEW, { overwrite: true })).resolves.toMatchObject({ passwordCleared: true })
    expect(await resolved()).toBeNull()
    expect(state.entries.size).toBe(0)
  })

  it('set_label leaves it as it is — config only, still read under <name>', async () => {
    legacyProd()
    await setConnectionLabel({ dataDir: dir, name: 'prod', label: 'Прод' })
    expect(loadConfig(dir).connections.prod?.passwordKey).toBeUndefined()
    expect(await resolved()).toBe('legacy')
  })

  it('remove deletes it under <name> and under the target’s key', async () => {
    legacyProd()
    await new SecretStore({ dataDir: dir }).write('prod', 'stray', { baseUrl: OLD, passwordKey: 'target' })
    await removeConnection({ dataDir: dir, name: 'prod' })
    expect(state.entries.size).toBe(0)
  })

  it('the CLI set-credentials verifies with it, then carries it', async () => {
    legacyProd()
    vi.stubGlobal('fetch', async () => new Response('<edmx:Edmx/>', { headers: { 'content-type': 'application/xml' } }))
    await runSetCredentials({ dataDir: dir, name: 'prod', login: 'u2' })
    expect(await resolved()).toBe('legacy')
  })
})

describe('a carry that cannot read the password keeps it where it is', () => {
  const relabel = (insecure = false) =>
    upsertConnection({ dataDir: dir, name: 'prod', baseUrl: OLD, login: 'u', label: 'x', insecure, overwrite: true })

  it('under --insecure-storage, which never reads the keychain: still keyed <name>, the keychain copy kept', async () => {
    const legacy = legacyProd()
    await expect(relabel(true)).resolves.toEqual({ overwritten: true })
    expect(loadConfig(dir).connections.prod).toMatchObject({ label: 'x' })
    expect(loadConfig(dir).connections.prod?.passwordKey).toBeUndefined()
    expect(entry(legacy)).toBe('legacy')
    expect(await resolved()).toBe('legacy')
  })

  it('where the keychain refuses to read: still keyed <name>, nothing lost', async () => {
    const legacy = legacyProd()
    state.readFails = true
    await relabel()
    state.readFails = false
    expect(loadConfig(dir).connections.prod?.passwordKey).toBeUndefined()
    expect(entry(legacy)).toBe('legacy')
  })

  it('a login-only set_credentials the same way', async () => {
    legacyProd()
    state.readFails = true
    await updateConnectionCredentials({
      dataDir: dir,
      name: 'prod',
      login: 'u2',
      expected: { baseUrl: OLD, login: 'u' },
    })
    state.readFails = false
    expect(loadConfig(dir).connections.prod).toMatchObject({ login: 'u2' })
    expect(loadConfig(dir).connections.prod?.passwordKey).toBeUndefined()
    expect(await resolved()).toBe('legacy')
  })

  it('a keychain password carried drops a stale file copy under the new key, which would outrank it', async () => {
    legacyProd('current')
    await new SecretStore({ dataDir: dir, insecure: true }).write('prod', 'stale', {
      baseUrl: OLD,
      passwordKey: 'target',
    })
    await relabel()
    expect(loadConfig(dir).connections.prod?.passwordKey).toBe('target')
    expect(await resolved()).toBe('current')
  })

  it('a credentials file it cannot read: still keyed <name>, the overwrite saved', async () => {
    legacyProd()
    writeFileSync(join(dir, 'credentials.json'), '{ broken', { mode: 0o600 })
    await expect(relabel()).resolves.toEqual({ overwritten: true })
    expect(loadConfig(dir).connections.prod).toMatchObject({ label: 'x' })
    expect(loadConfig(dir).connections.prod?.passwordKey).toBeUndefined()
  })

  it('a password in credentials.json is carried within the file, where an --insecure-storage reader finds it', async () => {
    saveConfig(dir, { connections: { prod: { baseUrl: OLD, login: 'u', serverTimezone: 'Europe/Moscow' } } })
    await new SecretStore({ dataDir: dir, insecure: true }).write('prod', 'in-file', NAME_KEY_OWNER)
    await relabel()
    expect(loadConfig(dir).connections.prod?.passwordKey).toBe('target')
    expect(await new FileConnectionSource({ dataDir: dir, insecure: true }).getSecret('prod')).toBe('in-file')
    expect(state.entries.size).toBe(0)
  })
})

describe('no password resurfaces for a connection given none', () => {
  it('a re-point drops a copy already under the new target’s key', async () => {
    await add(OLD, { password: 'old' })
    // A copy for NEW left by a save that failed earlier.
    await new SecretStore({ dataDir: dir }).write('prod', 'stale', { baseUrl: NEW, passwordKey: 'target' })
    await expect(add(NEW, { overwrite: true })).resolves.toMatchObject({ passwordCleared: true })
    expect(await resolved()).toBeNull()
  })

  it('a new connection drops a copy a remove could not delete', async () => {
    await add(OLD, { password: 'old' })
    state.deleteFails = true
    await removeConnection({ dataDir: dir, name: 'prod' })
    state.deleteFails = false
    await add(OLD)
    expect(await resolved()).toBeNull()
  })

  it('removing an agent’s connection deletes a person’s copy left under <name> too', async () => {
    state.entries.set(`${keychainServiceName(dir)}/prod`, 'persons')
    await upsertConnection({
      dataDir: dir,
      name: 'prod',
      baseUrl: OLD,
      login: 'u',
      serverTimezone: 'UTC',
      byAgent: true,
      password: 'agents',
    })
    await removeConnection({ dataDir: dir, name: 'prod' })
    expect(state.entries.size).toBe(0)
  })
})

describe('a failed config save deletes no password (#270)', () => {
  it('a re-point without a password: the connection keeps its target and its password', async () => {
    await add(OLD, { password: 'kept' })
    state.configSaveFails = true
    await expect(add(NEW, { overwrite: true })).rejects.toThrow(/ENOSPC/)
    state.configSaveFails = false
    expect(loadConfig(dir).connections.prod?.baseUrl).toBe(OLD)
    expect(await resolved()).toBe('kept')
  })

  it('the same on a connection still keyed <name>', async () => {
    legacyProd('kept')
    state.configSaveFails = true
    await expect(add(NEW, { overwrite: true })).rejects.toThrow(/ENOSPC/)
    state.configSaveFails = false
    expect(await resolved()).toBe('kept')
  })

  it('a re-point with a password: the old target keeps its own password', async () => {
    await add(OLD, { password: 'kept' })
    state.configSaveFails = true
    await expect(add(NEW, { password: 'new', overwrite: true })).rejects.toThrow(/ENOSPC/)
    state.configSaveFails = false
    expect(await resolved()).toBe('kept')
  })

  it('a new connection’s password does not outlive a save that failed', async () => {
    state.configSaveFails = true
    await expect(add(OLD, { password: 'never-saved' })).rejects.toThrow(/ENOSPC/)
    state.configSaveFails = false
    expect(state.entries.size).toBe(0)
  })

  it('a re-point’s new password does not outlive a save that failed', async () => {
    await add(OLD, { password: 'kept' })
    state.configSaveFails = true
    await expect(add(NEW, { password: 'never-saved', overwrite: true })).rejects.toThrow(/ENOSPC/)
    state.configSaveFails = false
    expect(entry({ baseUrl: NEW, passwordKey: 'target' })).toBeUndefined()
    expect(await resolved()).toBe('kept')
  })

  it('a carried password stays under <name> where the save fails', async () => {
    legacyProd('kept')
    state.configSaveFails = true
    await expect(
      upsertConnection({ dataDir: dir, name: 'prod', baseUrl: OLD, login: 'u', label: 'x', overwrite: true }),
    ).rejects.toThrow(/ENOSPC/)
    state.configSaveFails = false
    expect(loadConfig(dir).connections.prod?.passwordKey).toBeUndefined()
    expect(await resolved()).toBe('kept')
  })
})

describe('a base URL as a target (#272)', () => {
  it.each([
    ['HTTPS://Host.Example:443/База/odata/standard.odata/', 'https://host.example/База/odata/standard.odata'],
    ['http://host:80/odata', 'http://host/odata'],
    ['http://host:8080/odata', 'http://host:8080/odata'],
    ['https://host:80/odata', 'https://host:80/odata'],
    ['https://[::1]:443/odata', 'https://[::1]/odata'],
    ['https://[::1]:8443/odata', 'https://[::1]:8443/odata'],
    ['http://user:pw@Host/odata', 'http://host/odata'],
    ['http://host/ODATA/Path', 'http://host/ODATA/Path'],
    ['https://host:0443/odata', 'https://host/odata'],
    // `\\` ends the host, as a URL parser reads an http(s) URL: the path after it is not folded.
    ['http://Host\\Base/odata', 'http://host\\Base/odata'],
    ['http://host:08080/odata', 'http://host:8080/odata'],
    // Only ASCII is folded: a Unicode host stays as written (lower-casing Σ may pick another DNS name).
    ['https://ΑΒΓΣ.Example/odata', 'https://ΑΒΓΣ.example/odata'],
  ])('%s → %s', (given, target) => {
    expect(targetBaseUrl(given)).toBe(target)
  })

  it('an agent may overwrite its connection naming the default port: the same target', async () => {
    await upsertConnection({
      dataDir: dir,
      name: 'prod',
      baseUrl: 'https://host/odata',
      login: 'u',
      serverTimezone: 'UTC',
      byAgent: true,
      password: 'agents',
    })
    await expect(
      upsertConnection({
        dataDir: dir,
        name: 'prod',
        baseUrl: 'https://HOST:443/odata/',
        login: 'u',
        byAgent: true,
        label: 'x',
        overwrite: true,
      }),
    ).resolves.toMatchObject({ overwritten: true })
    expect(await resolved()).toBe('agents')
  })
})
