import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ConnectionSource } from '@1c-odata/mcp/internal'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { describe, expect, it, vi } from 'vitest'
import { createHttpServer } from '../../src/index.js'
import { runFlow } from './_harness.js'

const KEY = Buffer.alloc(32, 4).toString('base64')

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
    const { server, close, auth } = await createHttpServer({
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
      // Public sign-up is disabled, so the flow provisions the user via the admin
      // plugin on the server's OWN better-auth instance (exposed on the handle).
      const token = await runFlow(`${publicUrl}/api/auth`, publicUrl, auth, {
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
  })

  // --- Admin panel + health job are TENANCY-ONLY (db + keyring). ---

  it('no-auth mode: /admin is NOT mounted (404)', async () => {
    const { server, close } = await createHttpServer({ source, dataDir: '/synthetic' })
    server.listen(0, '127.0.0.1')
    await new Promise<void>((r) => server.once('listening', r))
    const { port } = server.address() as AddressInfo
    try {
      const res = await fetch(`http://127.0.0.1:${port}/admin`, { redirect: 'manual' })
      expect(res.status).toBe(404)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
      await close()
    }
  })

  it('auth WITHOUT keyring: /admin is NOT mounted (404), no health job started', async () => {
    const port = await freePort()
    const publicUrl = `http://127.0.0.1:${port}`
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const { server, close } = await createHttpServer({
      source,
      dataDir: '/synthetic',
      auth: { publicUrl, dialect: { kind: 'pglite' }, secret: SECRET }, // no keyring
    })
    server.listen(port, '127.0.0.1')
    await new Promise<void>((r) => server.once('listening', r))
    try {
      const res = await fetch(`${publicUrl}/admin`, { redirect: 'manual' })
      expect(res.status).toBe(404)
      // The health job (the only setInterval in our source) must not run here.
      const ours = setIntervalSpy.mock.calls.filter(([, ms]) => ms === 60_000)
      expect(ours.length).toBe(0)
    } finally {
      setIntervalSpy.mockRestore()
      await new Promise<void>((r) => server.close(() => r()))
      await close()
    }
  })

  it('full tenancy: /admin is mounted + gated, and close() stops the health job', async () => {
    const port = await freePort()
    const publicUrl = `http://127.0.0.1:${port}`
    const keyring = (await import('../../src/store/crypto.js')).loadKeyring({
      ONEC_MCP_ENC_KEY: KEY,
    } as NodeJS.ProcessEnv)
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    const { server, close } = await createHttpServer({
      source,
      dataDir: '/synthetic',
      auth: { publicUrl, dialect: { kind: 'pglite' }, secret: SECRET, keyring },
    })
    server.listen(port, '127.0.0.1')
    await new Promise<void>((r) => server.once('listening', r))
    try {
      // Admin is mounted and gated: an anonymous browser gets redirected to sign-in.
      const res = await fetch(`${publicUrl}/admin`, { redirect: 'manual' })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toContain('/sign-in')

      // The health job started (its 60s interval was created).
      const ours = setIntervalSpy.mock.calls.filter(([, ms]) => ms === 60_000)
      expect(ours.length).toBe(1)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
      await close() // must call the job's stop() → clearInterval
      expect(clearIntervalSpy).toHaveBeenCalled()
      setIntervalSpy.mockRestore()
      clearIntervalSpy.mockRestore()
    }
  })
})
