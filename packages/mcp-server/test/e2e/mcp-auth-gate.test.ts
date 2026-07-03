import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppWithAuth, type AuthHarness, startAppWithAuth, startAuthServer } from './_harness.js'

describe('e2e: /mcp requires a valid Bearer JWT', () => {
  let as: AuthHarness
  let app: AppWithAuth
  let appBase: string
  let mcpUrl: string

  beforeAll(async () => {
    // Give the AS an extra audience (`${as.base}/other`) so the wrong-aud test can
    // MINT a token for a different resource — the failure then lands on the
    // RS-side aud pin, not the AS-side allowlist.
    as = await startAuthServer(['/other'])
    app = await startAppWithAuth(as)
    appBase = app.appBase
    mcpUrl = app.mcpUrl
  })
  afterAll(async () => {
    await app.close()
    await as.close()
  })

  it('discovery: 200 PRM at /.well-known/oauth-protected-resource/mcp', async () => {
    const res = await fetch(`${appBase}/.well-known/oauth-protected-resource/mcp`)
    expect(res.status).toBe(200)
    const prm = await res.json()
    expect(prm.resource).toBe(mcpUrl)
    expect(prm.authorization_servers).toContain(as.base)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('discovery: 200 AS metadata at /.well-known/oauth-authorization-server', async () => {
    const res = await fetch(`${appBase}/.well-known/oauth-authorization-server`)
    expect(res.status).toBe(200)
    expect((await res.json()).jwks_uri).toContain('/jwks')
  })

  it('401 + WWW-Authenticate(resource_metadata) when no token', async () => {
    const res = await fetch(`${appBase}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    })
    expect(res.status).toBe(401)
    const wwwAuth = res.headers.get('www-authenticate') ?? ''
    expect(wwwAuth).toMatch(/Bearer/)
    expect(wwwAuth).toContain('resource_metadata')
  })

  it('200 + tools/list with a JWT minted by the AS (aud===our MCP_URL)', async () => {
    const token = await as.mintToken({ resource: mcpUrl, scope: 'mcp:read' })
    const transport = new StreamableHTTPClientTransport(new URL(`${appBase}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    })
    const client = new Client({ name: 'e2e', version: '0' })
    await client.connect(transport as Transport)
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['query', 'list_entities']))
    await client.close()
  })

  it('401 when the JWT aud is a DIFFERENT resource', async () => {
    // The AS harness includes `${as.base}/other` in validAudiences (see beforeAll),
    // so the token mints; the app's verifier pins audience=mcpUrl, so jose throws
    // JWTClaimValidationFailed → InvalidTokenError → 401. This exercises the
    // RS-side aud pin in isolation from the AS-side allowlist.
    const token = await as.mintToken({ resource: `${as.base}/other`, scope: 'mcp:read' })
    const res = await fetch(`${appBase}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    })
    expect(res.status).toBe(401)
  })
})
