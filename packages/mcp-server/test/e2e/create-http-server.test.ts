import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ConnectionSource } from '@1c-odata/mcp/internal'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { describe, expect, it } from 'vitest'
import { createHttpServer } from '../../src/index.js'
import { runFlow } from './_harness.js'

// Exercises the REAL production wiring path (createDb → runAuthMigrations →
// buildAuth → createAuthMount → createApp) end-to-end, which the other e2e files
// bypass by building the app via createApp directly. Also guards the now-async
// no-auth (Slice-1) branch and — because it boots via the real buildAuth over the
// committed auth-schema.ts — doubles as a schema-drift guard.

const SECRET = 'e2e-secret-not-for-prod-0123456789'

const source: ConnectionSource = {
  async getBase(name) {
    // baseUrl is never dereferenced here (tests do initialize + tools/list only).
    return name === 'demo' ? { baseUrl: 'http://example.invalid/odata', login: 'u', serverTimezone: 'UTC' } : undefined
  },
  async listBases() {
    return [{ name: 'demo', baseUrl: 'http://example.invalid/odata', login: 'u', serverTimezone: 'UTC' }]
  },
  async getSecret() {
    return 'p'
  },
  async secretSource() {
    return 'env'
  },
}

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
})
const INIT_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }

/** Reserve a free loopback port, then release it so the server can bind it (publicUrl must match the socket). */
async function freePort(): Promise<number> {
  const probe = createServer()
  const port = await new Promise<number>((r) =>
    probe.listen(0, '127.0.0.1', () => r((probe.address() as AddressInfo).port)),
  )
  await new Promise<void>((r) => probe.close(() => r()))
  return port
}

describe('e2e: createHttpServer (production wiring)', () => {
  it('no-auth mode: the async server round-trips /mcp initialize + tools/list', async () => {
    const { server, close } = await createHttpServer({ source, dataDir: '/synthetic' })
    server.listen(0, '127.0.0.1')
    await new Promise<void>((r) => server.once('listening', r))
    const { port } = server.address() as AddressInfo
    const client = new Client({ name: 'e2e', version: '0' })
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
      await client.connect(transport as Transport)
      const names = (await client.listTools()).tools.map((t) => t.name)
      expect(names).toEqual(expect.arrayContaining(['query', 'list_entities', 'server_info']))
    } finally {
      await client.close().catch(() => undefined)
      await new Promise<void>((r) => server.close(() => r()))
      await close()
    }
  })

  it('auth mode: the embedded AS gates /mcp, serves discovery, and admits a minted JWT', async () => {
    const port = await freePort()
    const publicUrl = `http://127.0.0.1:${port}`
    const { server, close } = await createHttpServer({
      source,
      dataDir: '/synthetic',
      auth: { publicUrl, dialect: { kind: 'pglite' }, secret: SECRET },
    })
    server.listen(port, '127.0.0.1')
    await new Promise<void>((r) => server.once('listening', r))
    const client = new Client({ name: 'e2e', version: '0' })
    try {
      // (1) No token → 401.
      const noTok = await fetch(`${publicUrl}/mcp`, { method: 'POST', headers: INIT_HEADERS, body: INIT_BODY })
      expect(noTok.status).toBe(401)

      // (2) Discovery is served by the embedded AS wiring.
      const prm = await fetch(`${publicUrl}/.well-known/oauth-protected-resource/mcp`)
      expect(prm.status).toBe(200)
      expect((await prm.json()).resource).toBe(`${publicUrl}/mcp`)
      const asm = await fetch(`${publicUrl}/.well-known/oauth-authorization-server`)
      expect(asm.status).toBe(200)

      // (3) A JWT minted against the server's OWN embedded AS passes the gate.
      const token = await runFlow(`${publicUrl}/api/auth`, publicUrl, {
        resource: `${publicUrl}/mcp`,
        scope: 'mcp:read',
      })
      const transport = new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      })
      await client.connect(transport as Transport)
      const names = (await client.listTools()).tools.map((t) => t.name)
      expect(names).toEqual(expect.arrayContaining(['query', 'list_entities']))
    } finally {
      await client.close().catch(() => undefined)
      await new Promise<void>((r) => server.close(() => r()))
      await close()
    }
  }, 30000)
})
