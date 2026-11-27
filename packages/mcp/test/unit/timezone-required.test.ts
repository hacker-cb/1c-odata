import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAdd } from '../../src/commands/add.js'
import { loadConfig } from '../../src/config.js'
import { ConnectionPool } from '../../src/connection-pool.js'
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

/** The interactive `add`, answered without a terminal: the answers in order, and every question asked. */
const prompts = vi.hoisted(() => ({ lines: [] as string[], asked: [] as string[] }))
vi.mock('../../src/commands/_prompt.js', () => ({
  promptLine: async (label: string, opts: { default?: string } = {}) => {
    prompts.asked.push(opts.default === undefined ? label : `${label} (default ${opts.default})`)
    return prompts.lines.shift() ?? ''
  },
  promptHidden: async () => '',
  promptConfirm: async () => true,
  readPasswordStdin: async () => '',
}))

const URL = 'http://base.test/odata/standard.odata'

let dir: string
/** Every URL a request was sent to: a refused add sends none. */
let fetched: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-tz-'))
  fetched = []
  prompts.lines = []
  prompts.asked = []
  vi.stubGlobal('fetch', async (url: string | URL) => {
    fetched.push(String(url))
    return new Response('<edmx:Edmx/>', { headers: { 'content-type': 'application/xml' } })
  })
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.stubEnv('ONEC_C_PASSWORD', '')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('serverTimezone has no default (#254)', () => {
  it('add_connection refuses a call without it, before any request, writing nothing', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    const pool = new ConnectionPool(new FileConnectionSource({ dataDir: dir, insecure: true }))
    registerManagementTools(server, pool, { dataDir: dir, insecure: true })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const mcp = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([server.connect(serverSide), mcp.connect(clientSide)])
    const res = await mcp.callTool({
      name: 'add_connection',
      arguments: { connection: 'c', baseUrl: URL, login: 'u', password: 'pw' },
    })
    const tools = await mcp.listTools()
    await Promise.all([mcp.close(), server.close()])
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('serverTimezone')
    expect(fetched).toEqual([])
    expect(loadConfig(dir).connections.c).toBeUndefined()
    const schema = tools.tools.find((t) => t.name === 'add_connection')?.inputSchema
    expect(schema?.required).toContain('serverTimezone')
    expect(JSON.stringify(schema)).not.toMatch(/default Europe/i)
  })

  it('add_connection stores the zone it is given', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    const pool = new ConnectionPool(new FileConnectionSource({ dataDir: dir, insecure: true }))
    registerManagementTools(server, pool, { dataDir: dir, insecure: true })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const mcp = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([server.connect(serverSide), mcp.connect(clientSide)])
    const res = await mcp.callTool({
      name: 'add_connection',
      arguments: { connection: 'c', baseUrl: URL, login: 'u', serverTimezone: 'Asia/Yekaterinburg' },
    })
    await Promise.all([mcp.close(), server.close()])
    expect(res.isError === true).toBe(false)
    expect(loadConfig(dir).connections.c?.serverTimezone).toBe('Asia/Yekaterinburg')
  })

  it.each([
    ['without --timezone', undefined],
    ['with a blank --timezone', '  '],
  ])('the CLI add refuses %s, before any request', async (_what, timezone) => {
    await expect(
      runAdd({
        dataDir: dir,
        insecure: true,
        name: 'c',
        url: URL,
        login: 'u',
        password: 'pw',
        ...(timezone !== undefined ? { timezone } : {}),
      }),
    ).rejects.toThrow(/--timezone is required/)
    expect(fetched).toEqual([])
    expect(loadConfig(dir).connections.c).toBeUndefined()
  })

  it('the interactive CLI add offers no default and asks again on a blank answer', async () => {
    prompts.lines = [URL, 'u', '', 'Asia/Yekaterinburg', '']
    await runAdd({ dataDir: dir, insecure: true, name: 'c' })
    const timezoneQuestions = prompts.asked.filter((q) => /timezone/i.test(q))
    expect(timezoneQuestions).toHaveLength(2)
    expect(timezoneQuestions.join()).not.toMatch(/default|\[/)
    expect(loadConfig(dir).connections.c?.serverTimezone).toBe('Asia/Yekaterinburg')
  })

  it('the interactive CLI add gives up after blank answers, writing nothing', async () => {
    prompts.lines = [URL, 'u', '', '', '']
    await expect(runAdd({ dataDir: dir, insecure: true, name: 'c' })).rejects.toThrow(/Server timezone is required/)
    expect(loadConfig(dir).connections.c).toBeUndefined()
  })
})
