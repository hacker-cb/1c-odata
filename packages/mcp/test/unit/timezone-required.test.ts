import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
const prompts = vi.hoisted(() => ({ lines: [] as string[], asked: [] as string[], stdinRead: 0 }))
vi.mock('../../src/commands/_prompt.js', () => ({
  promptLine: async (label: string, opts: { default?: string } = {}) => {
    prompts.asked.push(opts.default === undefined ? label : `${label} (default ${opts.default})`)
    return prompts.lines.shift() ?? ''
  },
  promptHidden: async () => '',
  promptConfirm: async () => true,
  readPasswordStdin: async () => {
    prompts.stdinRead++
    return 'pw'
  },
}))

const BASE_URL = 'http://base.test/odata/standard.odata'

let dir: string
/** Every URL a request was sent to: a refused add sends none. */
let fetched: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-tz-'))
  fetched = []
  prompts.lines = []
  prompts.asked = []
  prompts.stdinRead = 0
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

async function agent() {
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  const pool = new ConnectionPool(new FileConnectionSource({ dataDir: dir, insecure: true }))
  registerManagementTools(server, pool, { dataDir: dir, insecure: true })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)])
  const call = async (args: Record<string, unknown>) => {
    const res = await mcp.callTool({ name: 'add_connection', arguments: args })
    return { isError: res.isError === true, text: JSON.stringify(res.content) }
  }
  return { call, close: () => Promise.all([mcp.close(), server.close()]) }
}

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
      arguments: { connection: 'c', baseUrl: BASE_URL, login: 'u', password: 'pw' },
    })
    const tools = await mcp.listTools()
    await Promise.all([mcp.close(), server.close()])
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('required for the new connection')
    expect(fetched).toEqual([])
    expect(loadConfig(dir).connections.c).toBeUndefined()
    const schema = JSON.stringify(tools.tools.find((t) => t.name === 'add_connection')?.inputSchema)
    expect(schema).toContain('required for a new connection')
    expect(schema).not.toMatch(/default Europe/i)
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
      arguments: { connection: 'c', baseUrl: BASE_URL, login: 'u', serverTimezone: 'Asia/Yekaterinburg' },
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
        url: BASE_URL,
        login: 'u',
        password: 'pw',
        ...(timezone !== undefined ? { timezone } : {}),
      }),
    ).rejects.toThrow(
      /server timezone \(serverTimezone \/ --timezone\) (is required for the new connection|of "c" is blank)/,
    )
    expect(fetched).toEqual([])
    expect(loadConfig(dir).connections.c).toBeUndefined()
  })

  it('the interactive CLI add offers no default and asks again on a blank answer', async () => {
    prompts.lines = [BASE_URL, 'u', '', 'Asia/Yekaterinburg', '']
    await runAdd({ dataDir: dir, insecure: true, name: 'c' })
    const timezoneQuestions = prompts.asked.filter((q) => /timezone/i.test(q))
    expect(timezoneQuestions).toHaveLength(2)
    expect(timezoneQuestions.join()).not.toMatch(/default|\[/)
    expect(loadConfig(dir).connections.c?.serverTimezone).toBe('Asia/Yekaterinburg')
  })

  it('the interactive CLI add gives up after blank answers, writing nothing', async () => {
    prompts.lines = [BASE_URL, 'u', '', '', '']
    await expect(runAdd({ dataDir: dir, insecure: true, name: 'c' })).rejects.toThrow(/Server timezone is required/)
    expect(loadConfig(dir).connections.c).toBeUndefined()
  })

  describe('an overwrite', () => {
    beforeEach(async () => {
      prompts.lines = []
      await runAdd({
        dataDir: dir,
        insecure: true,
        name: 'c',
        url: BASE_URL,
        login: 'u',
        timezone: 'Asia/Yekaterinburg',
      })
      fetched = []
    })

    it('keeping the base BASE_URL keeps the stored zone where none is given (add_connection, add --force)', async () => {
      const { call, close } = await agent()
      expect(
        (await call({ connection: 'c', baseUrl: BASE_URL, login: 'u', label: 'x', overwrite: true })).isError,
      ).toBe(false)
      await close()
      expect(loadConfig(dir).connections.c).toMatchObject({ label: 'x', serverTimezone: 'Asia/Yekaterinburg' })
      await runAdd({ dataDir: dir, insecure: true, name: 'c', url: `${BASE_URL}/`, login: 'u2', force: true })
      expect(loadConfig(dir).connections.c).toMatchObject({ login: 'u2', serverTimezone: 'Asia/Yekaterinburg' })
    })

    it('moving to another server needs a zone: add --force refuses without one, before any request', async () => {
      await expect(
        runAdd({
          dataDir: dir,
          insecure: true,
          name: 'c',
          url: 'http://other.test/odata/standard.odata',
          login: 'u',
          password: 'pw',
          force: true,
        }),
      ).rejects.toThrow(/required for connection "c" when it moves to another server/)
      expect(fetched).toEqual([])
      expect(loadConfig(dir).connections.c?.baseUrl).toBe(BASE_URL)
    })

    it('a zone given replaces the stored one', async () => {
      const { call, close } = await agent()
      await call({ connection: 'c', baseUrl: BASE_URL, login: 'u', serverTimezone: 'Europe/Moscow', overwrite: true })
      await close()
      expect(loadConfig(dir).connections.c?.serverTimezone).toBe('Europe/Moscow')
    })
  })

  it('a mistyped zone fails before any request (add_connection, add)', async () => {
    const { call, close } = await agent()
    const res = await call({
      connection: 'c',
      baseUrl: BASE_URL,
      login: 'u',
      password: 'pw',
      serverTimezone: 'Europe/Mosocw',
    })
    await close()
    expect(res.isError).toBe(true)
    expect(res.text).toContain('not a valid IANA timezone')
    await expect(
      runAdd({
        dataDir: dir,
        insecure: true,
        name: 'c',
        url: BASE_URL,
        login: 'u',
        password: 'pw',
        timezone: 'Europe/Mosocw',
      }),
    ).rejects.toThrow(/not a valid IANA timezone/)
    expect(fetched).toEqual([])
  })

  it('the interactive CLI add asks again on an unknown zone', async () => {
    prompts.lines = [BASE_URL, 'u', 'Europe/Mosocw', 'Europe/Moscow', '']
    await runAdd({ dataDir: dir, insecure: true, name: 'c' })
    expect(prompts.asked.filter((q) => /timezone/i.test(q))).toHaveLength(2)
    expect(loadConfig(dir).connections.c?.serverTimezone).toBe('Europe/Moscow')
  })

  it('a blank zone for a new connection asks for a zone, offering nothing to keep', async () => {
    await expect(
      runAdd({ dataDir: dir, insecure: true, name: 'c', url: BASE_URL, login: 'u', timezone: ' ' }),
    ).rejects.toThrow(/is blank: give an IANA zone, e\.g\. Europe\/Moscow or Asia\/Yekaterinburg\.$/)
  })

  it('the CLI add refuses a missing zone before reading --password-stdin', async () => {
    await expect(
      runAdd({ dataDir: dir, insecure: true, name: 'c', url: BASE_URL, login: 'u', passwordStdin: true }),
    ).rejects.toThrow(/required for the new connection/)
    expect(prompts.stdinRead).toBe(0)
  })

  describe('over a stored connection', () => {
    const store = (serverTimezone: string) =>
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({ connections: { c: { baseUrl: BASE_URL, login: 'u', serverTimezone } } }),
      )

    it('the interactive add keeps the stored zone on Enter where the base BASE_URL stays', async () => {
      store('Asia/Yekaterinburg')
      prompts.lines = [BASE_URL, 'u', '', '']
      await runAdd({ dataDir: dir, insecure: true, name: 'c' })
      expect(prompts.asked.find((q) => /timezone/i.test(q))).toContain('Enter keeps Asia/Yekaterinburg')
      expect(loadConfig(dir).connections.c?.serverTimezone).toBe('Asia/Yekaterinburg')
    })

    it('a kept zone written with spaces is stored trimmed', async () => {
      store(' Asia/Yekaterinburg ')
      await runAdd({ dataDir: dir, insecure: true, name: 'c', url: BASE_URL, login: 'u', force: true })
      expect(loadConfig(dir).connections.c?.serverTimezone).toBe('Asia/Yekaterinburg')
    })

    it('a zone given blank is refused, not taken for an omitted one', async () => {
      store('Asia/Yekaterinburg')
      await expect(
        runAdd({ dataDir: dir, insecure: true, name: 'c', url: BASE_URL, login: 'u', timezone: ' ', force: true }),
      ).rejects.toThrow(/is blank: .*, or omit it to keep the stored one/)
      const { call, close } = await agent()
      const res = await call({ connection: 'c', baseUrl: BASE_URL, login: 'u', serverTimezone: '', overwrite: true })
      await close()
      expect(res.isError).toBe(true)
      expect(res.text).toContain('is blank')
    })
  })
})
