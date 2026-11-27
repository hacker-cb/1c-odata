import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { ConnectionPool } from '../../src/connection-pool.js'
import { upsertConnection } from '../../src/connections.js'
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

/** One request the stubbed 1С received, and whether its signal aborted while it hung. */
interface Hit {
  url: string
  aborted: boolean
}

/**
 * Stub `fetch` as a 1С whose `$metadata` never comes: the request hangs until
 * its signal aborts (or 5 s pass). `arrived` resolves at the first request.
 */
function hangingOneC() {
  let arrivedResolve: (hit: Hit) => void = () => {}
  const arrived = new Promise<Hit>((r) => {
    arrivedResolve = r
  })
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const hit: Hit = { url: decodeURIComponent(String(url)), aborted: false }
    arrivedResolve(hit)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 5000)
      init?.signal?.addEventListener('abort', () => {
        hit.aborted = true
        clearTimeout(timer)
        reject(init.signal?.reason)
      })
    })
    return new Response('<edmx:Edmx/>', { headers: { 'content-type': 'application/xml' } })
  })
  return { arrived }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-mgmt-cancel-'))
  // The stored password is what these tests read back: no env var may stand in for it.
  vi.stubEnv('ONEC_C_PASSWORD', '')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

/** The management tools on a real McpServer, a real MCP client over an in-memory transport. */
async function connect() {
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  const pool = new ConnectionPool(new FileConnectionSource({ dataDir: dir, insecure: true }))
  registerManagementTools(server, pool, { dataDir: dir, insecure: true })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)])
  return { mcp, close: () => Promise.all([mcp.close(), server.close()]) }
}

/** Call `name`, wait for its `$metadata` download to reach 1С, cancel the call; the hit, once aborted. */
async function cancelDuringVerify(name: string, args: Record<string, unknown>): Promise<Hit> {
  const { arrived } = hangingOneC()
  const { mcp, close } = await connect()
  const controller = new AbortController()
  const call = mcp.callTool({ name, arguments: args }, undefined, { signal: controller.signal })
  try {
    // A call settling before it reaches 1С is a failure of its own, not a timeout.
    const first = await Promise.race([arrived, call.then((r) => ({ settled: r }))])
    expect(first).not.toHaveProperty('settled')
    const hit = first as Hit
    expect(hit.url).toMatch(/\/\$metadata$/)
    controller.abort()
    await expect(call).rejects.toThrow()
    await vi.waitFor(() => expect(hit.aborted).toBe(true))
    // Let the tool's handler settle before the assertions on what it wrote.
    await new Promise((r) => setTimeout(r, 50))
    return hit
  } finally {
    await close()
  }
}

describe('a cancelled connection check aborts its $metadata download and writes nothing (#236)', () => {
  it('add_connection', async () => {
    await cancelDuringVerify('add_connection', {
      serverTimezone: 'UTC',
      connection: 'c',
      baseUrl: 'http://1c.test/odata/standard.odata',
      login: 'u',
      password: 'pw',
    })
    expect(loadConfig(dir).connections.c).toBeUndefined()
    // Under the key the agent's connection would have used: nothing written.
    expect(
      await new SecretStore({ dataDir: dir, insecure: true }).stored('c', {
        baseUrl: 'http://1c.test/odata/standard.odata',
        addedBy: 'agent',
      }),
    ).toBeNull()
  })

  it('set_credentials', async () => {
    await upsertConnection({
      dataDir: dir,
      name: 'c',
      baseUrl: 'http://1c.test/odata/standard.odata',
      login: 'u',
      serverTimezone: 'Europe/Moscow',
      password: 'old',
      insecure: true,
    })
    await cancelDuringVerify('set_credentials', { connection: 'c', login: 'u2', password: 'new' })
    expect(loadConfig(dir).connections.c?.login).toBe('u')
    expect(
      (await new SecretStore({ dataDir: dir, insecure: true }).read('c', loadConfig(dir).connections['c']))?.password,
    ).toBe('old')
  })
})
