import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAdd } from '../../src/commands/add.js'
import { runRemove } from '../../src/commands/remove.js'
import { runSetCredentials } from '../../src/commands/set-credentials.js'
import { loadConfig } from '../../src/config.js'
import { ConnectionPool } from '../../src/connection-pool.js'
import { removeConnection, setConnectionLabel, updateConnectionCredentials } from '../../src/connections.js'
import { FileConnectionSource } from '../../src/file-connection-source.js'
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

/** The interactive `add`, answered without a terminal: what was asked, and the answers in order. */
const prompts = vi.hoisted(() => ({ lines: [] as string[], confirms: [] as string[] }))
vi.mock('../../src/commands/_prompt.js', () => ({
  promptLine: async () => prompts.lines.shift() ?? '',
  promptHidden: async () => '',
  promptConfirm: async (question: string) => {
    prompts.confirms.push(question)
    return true
  },
  readPasswordStdin: async () => '',
}))

const URL = 'http://base.test/odata/standard.odata'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-proto-'))
  prompts.lines = []
  prompts.confirms = []
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
  // A broken read would have written these onto the global Object; none may be left.
  expect(Object.hasOwn(Object, 'label')).toBe(false)
  expect(Object.hasOwn(Object, 'login')).toBe(false)
})

/** `config.json` absent, or present with a `connections` that is no object: both read as no connections. */
const configs = [
  ['absent', () => undefined],
  ['without a connections object', () => writeFileSync(join(dir, 'config.json'), '{"connections": 1}')],
] as const

describe.each(configs)('a name the object prototype answers for, with config.json %s', (_what, writeConfig) => {
  beforeEach(() => writeConfig())

  it('loadConfig answers no connection for it', () => {
    const { connections } = loadConfig(dir)
    expect(connections.constructor).toBeUndefined()
    expect(connections.toString).toBeUndefined()
  })

  it('removeConnection reports nothing removed', async () => {
    expect(await removeConnection({ dataDir: dir, name: 'constructor', insecure: true })).toBe(false)
  })

  it('the CLI remove says there is no such connection', async () => {
    await expect(runRemove({ dataDir: dir, name: 'constructor', insecure: true, yes: true })).rejects.toThrow(
      'No connection named "constructor"',
    )
  })

  it('setConnectionLabel says there is no such connection', async () => {
    await expect(setConnectionLabel({ dataDir: dir, name: 'constructor', label: 'x' })).rejects.toThrow(
      'No connection named "constructor"',
    )
  })

  it('updateConnectionCredentials says there is no such connection', async () => {
    await expect(
      updateConnectionCredentials({ dataDir: dir, name: 'constructor', login: 'u', insecure: true }),
    ).rejects.toThrow('No connection named "constructor"')
  })

  it('the CLI set-credentials says there is no such connection', async () => {
    await expect(
      runSetCredentials({ dataDir: dir, name: 'constructor', login: 'u', insecure: true, noVerify: true }),
    ).rejects.toThrow('No connection named "constructor"')
  })

  it('the file source has no base for it, and the pool says there is no such connection', async () => {
    const source = new FileConnectionSource({ dataDir: dir, insecure: true })
    expect(await source.getBase('toString')).toBeUndefined()
    await expect(new ConnectionPool(source).get('toString')).rejects.toThrow('No connection named "toString"')
  })

  it('set_credentials says there is no such connection', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    const pool = new ConnectionPool(new FileConnectionSource({ dataDir: dir, insecure: true }))
    registerManagementTools(server, pool, { dataDir: dir, insecure: true })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const mcp = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([server.connect(serverSide), mcp.connect(clientSide)])
    const res = await mcp.callTool({ name: 'set_credentials', arguments: { connection: 'constructor', login: 'u' } })
    await Promise.all([mcp.close(), server.close()])
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('No connection named \\"constructor\\"')
  })

  it('the interactive CLI add takes it as a new connection, asking no overwrite', async () => {
    prompts.lines = [URL, 'u', 'UTC', '']
    await runAdd({ dataDir: dir, name: 'constructor', insecure: true })
    expect(prompts.confirms).toEqual([])
    expect(loadConfig(dir).connections.constructor).toMatchObject({ baseUrl: URL, login: 'u' })
  })
})
