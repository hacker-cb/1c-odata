import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionPool } from '../../src/connection-pool.js'
import { upsertConnection } from '../../src/connections.js'
import { FileConnectionSource } from '../../src/file-connection-source.js'
import { registerManagementTools } from '../../src/tools/management.js'

vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    getPassword(): string | null {
      return null
    }
    setPassword(): void {
      throw new Error('no keychain in tests')
    }
    deletePassword(): boolean {
      return false
    }
  },
}))

const BASE = 'http://1c.test/odata/standard.odata'
const EDMX =
  '<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx"><edmx:DataServices><Schema xmlns="http://schemas.microsoft.com/ado/2009/11/edm" Namespace="StandardODATA"><EntityContainer Name="EnterpriseV8" m:IsDefaultEntityContainer="true" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"/></Schema></edmx:DataServices></edmx:Edmx>'

let dir: string
/** The Basic-auth password of every `$metadata` download. */
let downloads: string[]

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-mgmt-pool-'))
  downloads = []
  vi.stubEnv('ONEC_C_PASSWORD', '')
  vi.stubGlobal('fetch', async (_url: string | URL, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    const decoded = Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString('utf8')
    downloads.push(decoded.slice(decoded.indexOf(':') + 1))
    return new Response(EDMX, { headers: { 'content-type': 'application/xml' } })
  })
  await upsertConnection({
    dataDir: dir,
    name: 'c',
    baseUrl: BASE,
    login: 'u',
    serverTimezone: 'UTC',
    password: 'old',
    insecure: true,
    byAgent: true,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

async function connect() {
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  const pool = new ConnectionPool(new FileConnectionSource({ dataDir: dir, insecure: true }))
  registerManagementTools(server, pool, { dataDir: dir, insecure: true })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)])
  return { pool, mcp }
}

describe('the management tools leave the pool to notice their changes (#274)', () => {
  it('a new password through set_credentials: the next get builds with it', async () => {
    const { pool, mcp } = await connect()
    const before = await pool.get('c')
    const res = await mcp.callTool({ name: 'set_credentials', arguments: { connection: 'c', password: 'new' } })
    expect(res.isError).toBeFalsy()
    const after = await pool.get('c')
    expect(after).not.toBe(before)
    expect(after.connection.auth).toMatchObject({ password: 'new' })
    await mcp.close()
  })

  it('a label-only overwrite through add_connection: the built client stays, no $metadata download', async () => {
    const { pool, mcp } = await connect()
    const before = await pool.get('c')
    const count = downloads.length
    const res = await mcp.callTool({
      name: 'add_connection',
      arguments: { connection: 'c', baseUrl: BASE, login: 'u', label: 'Прод', overwrite: true },
    })
    expect(res.isError).toBeFalsy()
    expect(await pool.get('c')).toBe(before)
    expect(downloads.length).toBe(count)
    await mcp.close()
  })

  it('remove_connection: the next get says there is no such connection', async () => {
    const { pool, mcp } = await connect()
    await pool.get('c')
    await mcp.callTool({ name: 'remove_connection', arguments: { connection: 'c' } })
    await expect(pool.get('c')).rejects.toThrow(/No connection named "c"/)
    await mcp.close()
  })
})
