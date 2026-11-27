import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAdd } from '../../src/commands/add.js'
import { runSetCredentials } from '../../src/commands/set-credentials.js'
import { loadConfig } from '../../src/config.js'
import { ConnectionPool } from '../../src/connection-pool.js'
import { updateConnectionCredentials, upsertConnection } from '../../src/connections.js'
import { FileConnectionSource } from '../../src/file-connection-source.js'
import { SecretStore } from '../../src/secret-store.js'
import { registerManagementTools } from '../../src/tools/management.js'

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

const OLD = 'http://old.test/odata/standard.odata'
const NEW = 'http://new.test/odata/standard.odata'

let dir: string
/** Every URL a request was sent to: none may reach the new server with the env password. */
let fetched: string[]

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-env-pw-'))
  fetched = []
  vi.stubGlobal('fetch', async (url: string | URL) => {
    fetched.push(String(url))
    return new Response('<edmx:Edmx/>', { headers: { 'content-type': 'application/xml' } })
  })
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.stubEnv('ONEC_C_PASSWORD', '')
  vi.stubEnv('ONEC_D_PASSWORD', '')
  await upsertConnection({
    dataDir: dir,
    name: 'c',
    baseUrl: OLD,
    login: 'u',
    serverTimezone: 'Europe/Moscow',
    password: 'stored',
    insecure: true,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/** Set the env password of connection `c`, which outranks the stored one on read. */
const envPassword = () => vi.stubEnv('ONEC_C_PASSWORD', 'from-env')

/** The stored password of `c` is still the one it was added with — read past the env var. */
async function expectStoredPasswordKept() {
  vi.stubEnv('ONEC_C_PASSWORD', '')
  expect((await stored().secret.read('c'))?.password).toBe('stored')
}

const stored = () => ({
  config: loadConfig(dir).connections.c,
  secret: new SecretStore({ dataDir: dir, insecure: true }),
})

async function tools() {
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  const pool = new ConnectionPool(new FileConnectionSource({ dataDir: dir, insecure: true }))
  registerManagementTools(server, pool, { dataDir: dir, insecure: true })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)])
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await mcp.callTool({ name, arguments: args })
    return { isError: res.isError === true, text: JSON.stringify(res.content) }
  }
  return { call, close: () => Promise.all([mcp.close(), server.close()]) }
}

describe('a password from ONEC_<NAME>_PASSWORD is never sent to a new target', () => {
  describe('add_connection with overwrite', () => {
    it.each([
      ['another base URL', { baseUrl: NEW, login: 'u' }],
      ['another login', { baseUrl: OLD, login: 'u2' }],
    ])('refuses %s, before any request, and changes nothing', async (_what, target) => {
      envPassword()
      const { call, close } = await tools()
      for (const password of [undefined, 'typed']) {
        const res = await call('add_connection', {
          connection: 'c',
          ...target,
          ...(password !== undefined ? { password } : {}),
          overwrite: true,
        })
        expect(res.isError).toBe(true)
        expect(res.text).toContain('1c-odata-mcp add c --force')
      }
      await close()
      expect(fetched).toEqual([])
      expect(stored().config).toMatchObject({ baseUrl: OLD, login: 'u' })
      await expectStoredPasswordKept()
    })

    it('refuses a new password for the same target: reads would keep the env one', async () => {
      envPassword()
      const { call, close } = await tools()
      const res = await call('add_connection', {
        connection: 'c',
        baseUrl: OLD,
        login: 'u',
        password: 'new',
        overwrite: true,
      })
      await close()
      expect(res.isError).toBe(true)
      expect(fetched).toEqual([])
      await expectStoredPasswordKept()
    })

    it('keeps the stored password over an overwrite to the same, differently written target', async () => {
      // Without the env var too: the stored password is cleared only for another target.
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({ connections: { c: { baseUrl: `${OLD}/`, login: 'u', serverTimezone: 'Europe/Moscow' } } }),
        { mode: 0o600 },
      )
      const { call, close } = await tools()
      const res = await call('add_connection', {
        connection: 'c',
        baseUrl: OLD,
        login: 'u',
        serverTimezone: 'UTC',
        overwrite: true,
      })
      await close()
      expect(res.isError).toBe(false)
      expect((await stored().secret.read('c'))?.password).toBe('stored')
    })

    it('reads a stored target as stored and normalized: a hand-written trailing slash is the same target', async () => {
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({ connections: { c: { baseUrl: `${OLD}/`, login: 'u', serverTimezone: 'Europe/Moscow' } } }),
        { mode: 0o600 },
      )
      envPassword()
      const { call, close } = await tools()
      const res = await call('add_connection', {
        connection: 'c',
        baseUrl: OLD,
        login: 'u',
        serverTimezone: 'UTC',
        overwrite: true,
      })
      await close()
      expect(res.isError).toBe(false)
    })

    it('still takes an overwrite keeping the target (a label, a timezone)', async () => {
      envPassword()
      const { call, close } = await tools()
      const res = await call('add_connection', {
        connection: 'c',
        baseUrl: `${OLD}/`,
        login: 'u',
        serverTimezone: 'UTC',
        overwrite: true,
      })
      await close()
      expect(res.isError).toBe(false)
      expect(stored().config).toMatchObject({ baseUrl: OLD, serverTimezone: 'UTC' })
    })

    it('refuses another target without the env var too: another process may hold it (#253)', async () => {
      const { call, close } = await tools()
      const res = await call('add_connection', { connection: 'c', baseUrl: NEW, login: 'u', overwrite: true })
      await close()
      expect(res.isError).toBe(true)
      expect(res.text).toContain('1c-odata-mcp add c --force')
      expect(fetched).toEqual([])
      expect(stored().config).toMatchObject({ baseUrl: OLD, login: 'u' })
      await expectStoredPasswordKept()
    })

    it('the CLI add --force still re-points one without the env var: the stored password is cleared', async () => {
      await runAdd({ dataDir: dir, insecure: true, name: 'c', url: NEW, login: 'u', force: true })
      expect(stored().config?.baseUrl).toBe(NEW)
      expect(await stored().secret.read('c')).toBeNull()
    })
  })

  describe('add_connection creating a connection (an agent never picks where the env password goes)', () => {
    it('refuses remove_connection then add_connection to another server, before any request', async () => {
      envPassword()
      const { call, close } = await tools()
      expect((await call('remove_connection', { connection: 'c' })).isError).toBe(false)
      const res = await call('add_connection', { connection: 'c', baseUrl: NEW, login: 'u' })
      await close()
      expect(res.isError).toBe(true)
      expect(res.text).toContain('ONEC_C_PASSWORD')
      expect(res.text).toContain('1c-odata-mcp add')
      expect(fetched).toEqual([])
      expect(stored().config).toBeUndefined()
    })

    it('creates as before without the env var', async () => {
      const { call, close } = await tools()
      const res = await call('add_connection', { connection: 'd', baseUrl: NEW, login: 'u' })
      await close()
      expect(res.isError).toBe(false)
      expect(loadConfig(dir).connections.d?.baseUrl).toBe(NEW)
    })

    it('the CLI add refuses a typed password for a new name under a set env var: reads would not use it', async () => {
      vi.stubEnv('ONEC_D_PASSWORD', 'from-env')
      await expect(
        runAdd({ dataDir: dir, insecure: true, name: 'd', url: NEW, login: 'u', password: 'typed' }),
      ).rejects.toThrow(/ONEC_D_PASSWORD/)
      expect(fetched).toEqual([])
    })

    it('the CLI add still creates one under a set env var (a person chose the target)', async () => {
      vi.stubEnv('ONEC_D_PASSWORD', 'from-env')
      await runAdd({ dataDir: dir, insecure: true, name: 'd', url: NEW, login: 'u' })
      expect(fetched).toEqual([`${NEW}/$metadata`])
      expect(loadConfig(dir).connections.d?.baseUrl).toBe(NEW)
    })
  })

  describe('races and odd names', () => {
    it('an overwrite queued behind a remove does not re-create the connection under the env password', async () => {
      envPassword()
      const { removeConnection } = await import('../../src/connections.js')
      // The preflight saw the connection; the remove takes the lock first.
      const removed = removeConnection({ dataDir: dir, name: 'c', insecure: true })
      const readded = upsertConnection({
        dataDir: dir,
        name: 'c',
        baseUrl: OLD,
        login: 'u',
        serverTimezone: 'UTC',
        insecure: true,
        overwrite: true,
        byAgent: true,
      })
      await removed
      await expect(readded).rejects.toThrow(/ONEC_C_PASSWORD/)
      expect(stored().config).toBeUndefined()
    })

    it('a name the config object inherits (constructor) is a new connection, not a crash', async () => {
      rmSync(join(dir, 'config.json'))
      vi.stubEnv('ONEC_CONSTRUCTOR_PASSWORD', 'from-env')
      const { call, close } = await tools()
      const res = await call('add_connection', { connection: 'constructor', baseUrl: NEW, login: 'u', overwrite: true })
      await close()
      expect(res.isError).toBe(true)
      expect(res.text).toContain('ONEC_CONSTRUCTOR_PASSWORD')
      await runAdd({ dataDir: dir, insecure: true, name: 'constructor', url: NEW, login: 'u', force: true })
      expect(loadConfig(dir).connections.constructor).toMatchObject({ baseUrl: NEW })
    })

    it('a name the config object inherits is no duplicate on a plain create, without --force', async () => {
      rmSync(join(dir, 'config.json'))
      await runAdd({ dataDir: dir, insecure: true, name: 'constructor', url: NEW, login: 'u' })
      expect(loadConfig(dir).connections.constructor).toMatchObject({ baseUrl: NEW })
    })

    it('an env var the environment object only inherits is no env password', async () => {
      const { SecretStore: Store } = await import('../../src/secret-store.js')
      const env = Object.create({ ONEC_C_PASSWORD: 'inherited' }) as NodeJS.ProcessEnv
      const store = new Store({ dataDir: dir, insecure: true, env })
      expect(await store.source('c')).toBe('file')
    })
  })

  describe('set_credentials', () => {
    it('refuses while the env var is set, before any request, and changes nothing', async () => {
      envPassword()
      const { call, close } = await tools()
      const res = await call('set_credentials', { connection: 'c', login: 'u2', password: 'new' })
      await close()
      expect(res.isError).toBe(true)
      expect(res.text).toContain('ONEC_C_PASSWORD')
      expect(fetched).toEqual([])
      expect(stored().config?.login).toBe('u')
    })

    it('without the env var, verifies and changes as before', async () => {
      const { call, close } = await tools()
      const res = await call('set_credentials', { connection: 'c', login: 'u2', password: 'new' })
      await close()
      expect(res.isError).toBe(false)
      expect(fetched).toHaveLength(1)
      expect(stored().config?.login).toBe('u2')
      expect((await stored().secret.read('c'))?.password).toBe('new')
    })
  })

  describe('the writes themselves (the authoritative check under the config lock)', () => {
    it('upsertConnection refuses an overwrite to another target', async () => {
      envPassword()
      await expect(
        upsertConnection({
          dataDir: dir,
          name: 'c',
          baseUrl: NEW,
          login: 'u',
          serverTimezone: 'Europe/Moscow',
          insecure: true,
          overwrite: true,
        }),
      ).rejects.toThrow(/ONEC_C_PASSWORD/)
      expect(stored().config?.baseUrl).toBe(OLD)
    })

    it('updateConnectionCredentials refuses', async () => {
      envPassword()
      await expect(
        updateConnectionCredentials({ dataDir: dir, name: 'c', password: 'new', insecure: true }),
      ).rejects.toThrow(/ONEC_C_PASSWORD/)
    })
  })

  describe('the CLI', () => {
    it('add --force to another URL refuses before verifying', async () => {
      envPassword()
      await expect(
        runAdd({ dataDir: dir, insecure: true, name: 'c', url: NEW, login: 'u', force: true }),
      ).rejects.toThrow(/ONEC_C_PASSWORD/)
      expect(fetched).toEqual([])
      expect(stored().config?.baseUrl).toBe(OLD)
    })

    it('set-credentials refuses before verifying', async () => {
      envPassword()
      await expect(runSetCredentials({ dataDir: dir, insecure: true, name: 'c', password: 'new' })).rejects.toThrow(
        /ONEC_C_PASSWORD/,
      )
      expect(fetched).toEqual([])
    })
  })
})
