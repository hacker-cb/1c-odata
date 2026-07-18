import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AppWithAuth, type AuthHarness, startAppWithAuth, startAuthServer } from './_harness.js'

/**
 * Regression guard for #106: token verification must not depend on the server
 * being able to reach its own public origin over the network.
 *
 * The verifier used to fetch `${issuer}/.well-known/oauth-authorization-server`
 * and then the advertised `jwks_uri` — both on the PUBLIC origin. In a single-host
 * deploy behind a reverse proxy without hairpin-NAT / split-horizon DNS the
 * container cannot resolve or reach that origin, so every bearer check failed and
 * the whole OAuth mode was dead. Keys now come from the AS in-process.
 *
 * The test makes the public origin genuinely unreachable — the AS's HTTP socket is
 * CLOSED after the token is minted, while its better-auth instance (and the `jwks`
 * table behind it) stays alive, exactly as in a co-located deploy.
 */
describe('e2e: /mcp verifies JWTs with the AS origin unreachable (#106)', () => {
  let as: AuthHarness
  let app: AppWithAuth
  let token: string

  beforeAll(async () => {
    as = await startAuthServer()
    app = await startAppWithAuth(as)
    token = await as.mintToken({ resource: app.mcpUrl, scope: 'mcp:read' })
    await as.closeHttp() // the public origin is now dead — no metadata, no JWKS over HTTP
  })
  afterAll(async () => {
    await app.close()
    await as.close()
  })

  it('the AS origin really is unreachable', async () => {
    await expect(fetch(`${as.base}/jwks`)).rejects.toThrow()
  })

  it('initialize + tools/list still succeed on a valid Bearer JWT', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${app.appBase}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    })
    const client = new Client({ name: 'e2e', version: '0' })
    await client.connect(transport as Transport)
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['query', 'list_entities']))
    await client.close()
  })

  it('an invalid token is still rejected — the gate did not degrade to open', async () => {
    const res = await fetch(`${app.appBase}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.slice(0, -2)}xx`, // tampered signature
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
