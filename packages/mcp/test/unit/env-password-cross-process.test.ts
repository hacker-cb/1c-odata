import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAdd } from '../../src/commands/add.js'
import { runList } from '../../src/commands/list.js'
import { runSetCredentials } from '../../src/commands/set-credentials.js'
import { loadConfig } from '../../src/config.js'
import { ConnectionPool } from '../../src/connection-pool.js'
import { upsertConnection } from '../../src/connections.js'
import { FileConnectionSource } from '../../src/file-connection-source.js'
import { SecretStore } from '../../src/secret-store.js'
import { registerManagementTools } from '../../src/tools/management.js'

// Isolate from the real OS keychain.
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

/**
 * #253: the data dir is shared by every MCP process, while `ONEC_<NAME>_PASSWORD`
 * is set per process. Process B (an agent, without the variable) writes
 * `config.json`; process A (with it) then builds a client from what B wrote.
 * Here both are this test process, the variable stubbed on for A and off for B.
 */

const OLD = 'http://old.test/odata/standard.odata'
const EVIL = 'http://agent.test/odata/standard.odata'
const ENV_PASSWORD = 'from-env'

let dir: string
/** Every request sent: its URL and the Basic-auth password it carried. */
let sent: { url: string; password: string }[]

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-env-xproc-'))
  sent = []
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    const decoded = Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString('utf8')
    sent.push({ url: String(url), password: decoded.slice(decoded.indexOf(':') + 1) })
    return new Response('<edmx:Edmx/>', { headers: { 'content-type': 'application/xml' } })
  })
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  processB()
  // A person added `prod` with the CLI; its password lives only in process A's environment.
  await upsertConnection({
    dataDir: dir,
    name: 'prod',
    baseUrl: OLD,
    login: 'u',
    serverTimezone: 'UTC',
    insecure: true,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/** Process A: the operator set `ONEC_PROD_PASSWORD` (and `ONEC_NEW_PASSWORD`) for it. */
function processA() {
  vi.stubEnv('ONEC_PROD_PASSWORD', ENV_PASSWORD)
  vi.stubEnv('ONEC_NEW_PASSWORD', ENV_PASSWORD)
}

/** Process B: neither variable. */
function processB() {
  vi.stubEnv('ONEC_PROD_PASSWORD', '')
  vi.stubEnv('ONEC_NEW_PASSWORD', '')
}

const pool = () => new ConnectionPool(new FileConnectionSource({ dataDir: dir, insecure: true }))

/** Build `name` in process A as far as its `$metadata` request — the stub's body parses no further. */
const fetchMetadata = (name: string) =>
  pool()
    .get(name)
    .catch(() => undefined)

async function agent() {
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  registerManagementTools(server, pool(), { dataDir: dir, insecure: true })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)])
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await mcp.callTool({ name, arguments: args })
    return { isError: res.isError === true, text: JSON.stringify(res.content) }
  }
  return { call, close: () => Promise.all([mcp.close(), server.close()]) }
}

/** Every request process A sent to the agent's server carried no env password. */
const expectEnvPasswordNeverSentTo = (url: string) =>
  expect(sent.filter((r) => r.url.startsWith(url) && r.password === ENV_PASSWORD)).toEqual([])

describe('an agent in a process without ONEC_<NAME>_PASSWORD cannot route it elsewhere (#253)', () => {
  it('add_connection with overwrite to another server is refused', async () => {
    const { call, close } = await agent()
    const res = await call('add_connection', { connection: 'prod', baseUrl: EVIL, login: 'u', overwrite: true })
    await close()
    expect(res.isError).toBe(true)
    expect(loadConfig(dir).connections.prod).toMatchObject({ baseUrl: OLD })
    expect(loadConfig(dir).connections.prod?.addedBy).toBeUndefined()
  })

  it('remove_connection + add_connection: the re-created connection is the agent’s, and takes no env password', async () => {
    const { call, close } = await agent()
    expect((await call('remove_connection', { connection: 'prod' })).isError).toBe(false)
    expect((await call('add_connection', { connection: 'prod', baseUrl: EVIL, login: 'u' })).isError).toBe(false)
    await close()
    expect(loadConfig(dir).connections.prod).toMatchObject({ baseUrl: EVIL, addedBy: 'agent' })

    processA()
    await expect(pool().get('prod')).rejects.toThrow(
      /No password for "prod"\. An agent added it, so ONEC_PROD_PASSWORD/,
    )
    expect(sent).toEqual([])
    const [listed] = await pool().list()
    expect(listed).toMatchObject({ name: 'prod', passwordSource: 'none', addedBy: 'agent' })
  })

  it('a name nobody added yet: the agent’s connection takes no env password either', async () => {
    const { call, close } = await agent()
    expect((await call('add_connection', { connection: 'new', baseUrl: EVIL, login: 'u' })).isError).toBe(false)
    await close()
    processA()
    await expect(pool().get('new')).rejects.toThrow(/No password for "new"/)
    expect(sent).toEqual([])
  })

  it('a password the agent gave goes where the agent pointed it — the env one never does', async () => {
    const { call, close } = await agent()
    await call('remove_connection', { connection: 'prod' })
    expect(
      (await call('add_connection', { connection: 'prod', baseUrl: EVIL, login: 'u', password: 'agents-own' })).isError,
    ).toBe(false)
    await close()
    processA()
    sent = []
    await fetchMetadata('prod')
    expect(sent).toEqual([{ url: `${EVIL}/$metadata`, password: 'agents-own' }])
    expectEnvPasswordNeverSentTo(EVIL)
  })

  it('an overwrite keeping the target keeps who chose it: a person’s stays a person’s', async () => {
    const { call, close } = await agent()
    const res = await call('add_connection', {
      connection: 'prod',
      baseUrl: OLD,
      login: 'u',
      serverTimezone: 'Europe/Moscow',
      overwrite: true,
    })
    await close()
    expect(res.isError).toBe(false)
    expect(loadConfig(dir).connections.prod).toMatchObject({ serverTimezone: 'Europe/Moscow' })
    expect(loadConfig(dir).connections.prod?.addedBy).toBeUndefined()
    processA()
    await fetchMetadata('prod')
    expect(sent).toEqual([{ url: `${OLD}/$metadata`, password: ENV_PASSWORD }])
  })

  it('an overwrite keeping the target keeps who chose it: an agent’s stays an agent’s', async () => {
    const { call, close } = await agent()
    await call('add_connection', { connection: 'new', baseUrl: EVIL, login: 'u' })
    const res = await call('add_connection', {
      connection: 'new',
      baseUrl: EVIL,
      login: 'u',
      label: 'x',
      overwrite: true,
    })
    await close()
    expect(res.isError).toBe(false)
    expect(loadConfig(dir).connections.new).toMatchObject({ label: 'x', addedBy: 'agent' })
  })

  it('the CLI add --force — a person choosing the target — drops the mark, and the env password applies again', async () => {
    const { call, close } = await agent()
    await call('add_connection', { connection: 'new', baseUrl: EVIL, login: 'u' })
    await close()
    await runAdd({ dataDir: dir, insecure: true, name: 'new', url: OLD, login: 'u', force: true })
    expect(loadConfig(dir).connections.new?.addedBy).toBeUndefined()
    processA()
    sent = []
    await fetchMetadata('new')
    expect(sent).toEqual([{ url: `${OLD}/$metadata`, password: ENV_PASSWORD }])
  })

  it('credentials of an agent’s connection change under a set env var: reads would use them, not the env one', async () => {
    const { call, close } = await agent()
    await call('add_connection', { connection: 'new', baseUrl: EVIL, login: 'u' })
    processA()
    const res = await call('set_credentials', { connection: 'new', password: 'agents-own' })
    await close()
    expect(res.isError).toBe(false)
    expectEnvPasswordNeverSentTo(EVIL)
    await runSetCredentials({ dataDir: dir, insecure: true, name: 'new', password: 'typed' })
    expect(
      await new SecretStore({ dataDir: dir, insecure: true }).read('new', loadConfig(dir).connections.new),
    ).toEqual({
      password: 'typed',
      source: 'file',
    })
    expectEnvPasswordNeverSentTo(EVIL)
  })

  it('the CLI list says the env var is not used for an agent’s connection', async () => {
    const { call, close } = await agent()
    await call('add_connection', { connection: 'new', baseUrl: EVIL, login: 'u' })
    await close()
    processA()
    const out: string[] = []
    vi.mocked(process.stdout.write).mockImplementation((chunk) => {
      out.push(String(chunk))
      return true
    })
    await runList({ dataDir: dir, insecure: true })
    const text = out.join('')
    expect(text).toMatch(/new\n[\s\S]*password: none\n {4}added by: an agent \(add_connection\) — ONEC_NEW_PASSWORD/)
    expect(text).toMatch(/prod\n[\s\S]*password: env\n\n/)
  })
})

describe('config.json keeps the mark as written', () => {
  it('keeps addedBy "agent" and drops any other value', () => {
    const conn = { baseUrl: OLD, login: 'u', serverTimezone: 'UTC' }
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ connections: { a: { ...conn, addedBy: 'agent' }, b: { ...conn, addedBy: 'person' } } }),
    )
    const { connections } = loadConfig(dir)
    expect(connections.a?.addedBy).toBe('agent')
    expect(connections.b).toEqual(conn)
  })
})
