// test/e2e/session-binding.test.ts
// Session↔sub hijack test. A SINGLE shared router (one createMcpRouter instance)
// behind a fake bearer layer that reads `req.auth.extra.sub` from an `x-test-sub`
// header — so we can drive two principals against ONE session without minting real
// JWTs, and assert the real 403 path directly against resolveOwnedSession.
//
// supertest is not a dep of this package; we drive the router over a real loopback
// socket with fetch, matching the existing e2e harness style (mcp-endpoint.test.ts).
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ReadPool } from '@1c-odata/mcp/internal'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMcpRouter } from '../../src/http/mcp-route.js'
import { buildMcpServer } from '../../src/server-factory.js'

// A trivial ReadPool with no bases — enough for initialize + a tool-list ping.
const emptyPool: ReadPool = {
  async get() {
    throw new Error('none')
  },
  async list() {
    return []
  },
  refresh() {},
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
}

const ACCEPT = 'application/json, text/event-stream'

/**
 * One app, one MCP router. A fake bearer layer sets `req.auth.extra.sub` from the
 * `x-test-sub` header (mirrors how requireBearerAuth sets req.auth from the JWT's
 * verifier output), so flipping the header between requests switches principals.
 */
function startApp(): Promise<{ server: Server; url: string; stop: () => void }> {
  const app = express()
  app.use('/mcp', (req, _res, next) => {
    const sub = req.headers['x-test-sub']
    if (typeof sub === 'string' && sub !== '') {
      ;(req as { auth?: unknown }).auth = { extra: { sub }, scopes: ['mcp:read'] }
    }
    next()
  })
  app.use(express.json())
  const mcp = createMcpRouter({
    buildServer: () => buildMcpServer(emptyPool, { version: 't', dataDir: '/tmp' }),
  })
  app.use('/mcp', mcp.router)
  const server = app.listen(0, '127.0.0.1')
  return new Promise((resolve) =>
    server.once('listening', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, url: `http://127.0.0.1:${port}/mcp`, stop: () => mcp.sessions.stop() })
    }),
  )
}

describe('session ↔ sub binding', () => {
  let server: Server
  let url: string
  let stop: () => void

  beforeEach(async () => {
    ;({ server, url, stop } = await startApp())
  })

  afterEach(async () => {
    stop()
    await new Promise<void>((r) => server.close(() => r()))
  })

  async function openSession(sub: string): Promise<string> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: ACCEPT, 'x-test-sub': sub },
      body: JSON.stringify(INIT),
    })
    expect(res.status).toBe(200)
    const sid = res.headers.get('mcp-session-id')
    expect(sid).toBeTruthy()
    return sid as string
  }

  it('a foreign sub replaying an existing session id gets 403', async () => {
    // Alice opens the session.
    const sid = await openSession('alice')

    // Bob (valid token, different sub) reuses Alice's live session id → 403.
    const hijack = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: ACCEPT, 'mcp-session-id': sid, 'x-test-sub': 'bob' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    })
    expect(hijack.status).toBe(403)
    const body = (await hijack.json()) as { error?: { message?: string } }
    expect(body.error?.message).toBe('Session does not belong to this principal')
  })

  it('the owning sub on its own session is accepted (not 403)', async () => {
    const sid = await openSession('alice')
    const ok = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: ACCEPT, 'mcp-session-id': sid, 'x-test-sub': 'alice' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    })
    // The owner is not rejected: a real JSON-RPC response (200), never a 403/400.
    expect(ok.status).toBe(200)
  })

  it('an unknown session id is 404 so the client re-initializes (before any ownership check)', async () => {
    // A present-but-unknown Mcp-Session-Id (swept idle session, or a post-DELETE id)
    // MUST be 404 per the Streamable-HTTP spec — the client then transparently opens
    // a fresh session. 400 is reserved for a request MISSING the header entirely.
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: ACCEPT,
        'mcp-session-id': 'does-not-exist',
        'x-test-sub': 'alice',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    })
    expect(res.status).toBe(404)
  })

  it('a request with NO Mcp-Session-Id header is 400 (missing), distinct from the 404 unknown-id path', async () => {
    // The slice deliberately splits 400 ("header absent") from 404 ("id present but
    // unknown"). A header-less DELETE/GET must hit the 400 branch, never 404.
    const del = await fetch(url, { method: 'DELETE', headers: { accept: ACCEPT, 'x-test-sub': 'alice' } })
    expect(del.status).toBe(400)
    const get = await fetch(url, { method: 'GET', headers: { accept: ACCEPT, 'x-test-sub': 'alice' } })
    expect(get.status).toBe(400)
  })

  it('a terminated (DELETE) session id then 404s — the reclaim → re-init contract', async () => {
    const sid = await openSession('alice')
    // Terminate the session explicitly.
    const del = await fetch(url, {
      method: 'DELETE',
      headers: { accept: ACCEPT, 'mcp-session-id': sid, 'x-test-sub': 'alice' },
    })
    expect(del.status).toBeLessThan(300)
    // Its id is now unknown → 404 (not 403/400), so the owner re-initializes cleanly.
    const after = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: ACCEPT, 'mcp-session-id': sid, 'x-test-sub': 'alice' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    })
    expect(after.status).toBe(404)
  })
})
