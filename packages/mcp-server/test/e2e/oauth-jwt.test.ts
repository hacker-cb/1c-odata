import { createRemoteJWKSet, jwtVerify } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AuthHarness, startAuthServer } from './_harness.js'

describe('e2e: oauthProvider issues an offline-verifiable JWT', () => {
  let as: AuthHarness
  beforeAll(async () => {
    as = await startAuthServer()
  })
  afterAll(async () => {
    await as.close()
  })

  it('with resource=MCP_URL → JWT whose aud includes MCP_URL and has a sub', async () => {
    const token = await as.mintToken({ resource: as.mcpUrl, scope: 'mcp:read' })
    expect(token.split('.')).toHaveLength(3) // not opaque
    const jwks = createRemoteJWKSet(new URL(`${as.base}/jwks`))
    const { payload } = await jwtVerify(token, jwks, { issuer: as.base, audience: as.mcpUrl })
    // The `openid` scope adds the userinfo endpoint as a second audience, so
    // `aud` is an array — assert MEMBERSHIP, not string equality. (jwtVerify
    // with `audience` above already enforced membership.)
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    expect(aud).toContain(as.mcpUrl)
    expect(payload.sub).toEqual(expect.any(String))
    expect(String(payload.scope)).toContain('mcp:read')
  })

  it('WITHOUT resource → opaque token (regression guard on the silent downgrade)', async () => {
    const token = await as.mintToken({})
    expect(token.split('.')).not.toHaveLength(3)
  })

  it('resource not in validAudiences → token endpoint rejects', async () => {
    await expect(as.mintToken({ resource: 'https://evil.example/mcp' })).rejects.toThrow(/invalid|resource|400|token/i)
  })
})
