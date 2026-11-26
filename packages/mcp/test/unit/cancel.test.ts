import { BasicAuth, ODataV3Client } from '@1c-odata/client'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PoolEntry, ReadPool } from '../../src/connection-pool.js'
import { DEFAULT_LIMITS } from '../../src/limits.js'
import { registerDataTools } from '../../src/tools/data.js'

const GUID = '11111111-2222-3333-4444-555555555555'

/** One request the stubbed 1С received, and whether its signal aborted while it hung. */
interface Hit {
  url: string
  aborted: boolean
}

/**
 * Stub `fetch` as a 1С that never answers: every request hangs until its own
 * signal aborts (or 2 s pass), and is recorded with whether it was aborted.
 * `arrived` resolves once `expected` requests are in flight.
 */
function hangingOneC(expected: number) {
  const hits: Hit[] = []
  let arrivedResolve: () => void = () => {}
  const arrived = new Promise<void>((r) => {
    arrivedResolve = r
  })
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const hit: Hit = { url: String(url), aborted: false }
    hits.push(hit)
    if (hits.length === expected) arrivedResolve()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 2000)
      init?.signal?.addEventListener('abort', () => {
        hit.aborted = true
        clearTimeout(timer)
        reject(init.signal?.reason)
      })
    })
    return new Response(JSON.stringify({ value: [] }), { headers: { 'content-type': 'application/json' } })
  })
  return { hits, arrived }
}

/**
 * The data tools on a real McpServer, a real MCP client over an in-memory
 * transport, and a real ODataV3Client — so a cancel travels the whole way: the
 * client's `notifications/cancelled`, the SDK's `extra.signal`, the tool, the
 * 1С client, `fetch`.
 */
async function connect() {
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  const client1c = new ODataV3Client({
    baseUrl: 'http://1c.test/odata/standard.odata',
    auth: BasicAuth({ username: 'u', password: 'p' }),
    serverTimezone: 'Europe/Moscow',
  })
  const pool = { get: async () => ({ client: client1c }) as unknown as PoolEntry } as unknown as ReadPool
  registerDataTools(server, pool, DEFAULT_LIMITS)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const mcp = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)])
  return { mcp, close: () => Promise.all([mcp.close(), server.close()]) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('an MCP request cancelled by its client aborts the requests to 1С (#216)', () => {
  const cases: [string, Record<string, unknown>, number][] = [
    ['query', { connection: 'c', entitySet: 'Catalog_Валюты' }, 1],
    ['query', { connection: 'c', entitySet: 'Catalog_Валюты', count: true }, 2],
    ['get_entity', { connection: 'c', entitySet: 'Catalog_Валюты', key: GUID }, 1],
    ['count', { connection: 'c', entitySet: 'Catalog_Валюты' }, 1],
    ['register_query', { connection: 'c', register: 'AccumulationRegister_X', table: 'balance' }, 2],
  ]

  it.each(cases)('%s %j: every request to 1С in flight is aborted', async (name, args, expected) => {
    const { hits, arrived } = hangingOneC(expected)
    const { mcp, close } = await connect()
    try {
      const ctrl = new AbortController()
      const call = mcp.callTool({ name, arguments: args }, undefined, { signal: ctrl.signal }).catch((e: unknown) => e)
      // A call that ends before all its requests reach 1С fails here with what it answered.
      const early = await Promise.race([arrived.then(() => undefined), call])
      expect(early, `the call ended with ${hits.length} of ${expected} request(s) sent`).toBeUndefined()
      ctrl.abort(new Error('agent gave up'))
      // The MCP client rejects at once; the server hears the cancel a tick later.
      expect(await call).toBeInstanceOf(Error)
      await vi.waitFor(() => expect(hits.every((h) => h.aborted)).toBe(true), { timeout: 1000 })
      expect(hits).toHaveLength(expected)
    } finally {
      await close()
    }
  })

  it('a call not cancelled completes, its requests left alone', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ value: [] }), { headers: { 'content-type': 'application/json' } }),
    )
    const { mcp, close } = await connect()
    try {
      const res = await mcp.callTool({ name: 'query', arguments: { connection: 'c', entitySet: 'Catalog_Валюты' } })
      expect(res.isError).toBeFalsy()
    } finally {
      await close()
    }
  })
})
