// packages/mcp-server/scripts/spike-jwt.mjs
// Keystone gate: prove @better-auth/oauth-provider mints an offline-verifiable
// JWT whose aud === our MCP resource URL. Run with `node scripts/spike-jwt.mjs`.
// Exits non-zero on any failure — that is the proof gate for Slice 2.
import { strict as assert } from 'node:assert'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { oauthProvider } from '@better-auth/oauth-provider'
import { PGlite } from '@electric-sql/pglite'
import { betterAuth } from 'better-auth'
import { admin, jwt } from 'better-auth/plugins'
import { pushSchema } from 'drizzle-kit/api'
import { drizzle } from 'drizzle-orm/pglite'
import { createRemoteJWKSet, jwtVerify } from 'jose'
// Node strips types natively (>=22.21); import the generated TS schema directly.
import * as schema from '../auth-schema.ts'

const REDIRECT_URI = 'http://127.0.0.1:9999/callback' // never dereferenced (headless)

const b64url = (buf) => buf.toString('base64url')
const codeVerifier = b64url(randomBytes(32))
const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest())

async function buildAuth(publicUrl) {
  const client = new PGlite() // in-memory; dies with the process
  const db = drizzle(client, { schema })
  const { apply } = await pushSchema(schema, db) // create better-auth's tables
  await apply()

  const mcpUrl = `${publicUrl}/mcp` // the RFC 8707 resource == the audience we prove
  const auth = betterAuth({
    baseURL: publicUrl,
    secret: 'spike-secret-not-for-prod-0123456789',
    emailAndPassword: { enabled: true },
    database: drizzleAdapter(db, { provider: 'pg' }),
    plugins: [
      jwt(),
      admin(),
      oauthProvider({
        loginPage: '/sign-in',
        consentPage: '/consent',
        validAudiences: [mcpUrl],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        scopes: ['openid', 'profile', 'email', 'offline_access', 'mcp:read'],
      }),
    ],
  })
  return { auth, mcpUrl }
}

function serve(auth, port = 0) {
  const server = createServer(async (req, res) => {
    const url = `http://${req.headers.host}${req.url}`
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = chunks.length ? Buffer.concat(chunks) : undefined
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      ...(body && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}),
    })
    const response = await auth.handler(request)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined)
  })
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => {
      const { port: boundPort } = server.address()
      resolve({ server, port: boundPort, publicUrl: `http://127.0.0.1:${boundPort}` })
    }),
  )
}

const collectCookies = (headers) =>
  headers
    .getSetCookie()
    .map((c) => c.split(';', 1)[0])
    .join('; ')

async function main() {
  // Two-phase boot: iss/aud default to baseURL, which must equal the listening
  // origin for jwtVerify to match. Grab a free port from the boot socket, close
  // it, then REBIND the live server on that SAME port so publicUrl stays valid.
  const boot = await buildAuth('http://127.0.0.1:1')
  const first = await serve(boot.auth)
  const publicUrl = first.publicUrl
  const port = first.port
  await new Promise((r) => first.server.close(r))

  const { auth, mcpUrl } = await buildAuth(publicUrl)
  const live = await serve(auth, port)
  const base = `${publicUrl}/api/auth`

  try {
    const email = 'spike@example.com'
    const password = 'Password123!'
    await auth.api.signUpEmail({ body: { email, password, name: 'Spike' } })
    const { headers: signInHeaders } = await auth.api.signInEmail({
      body: { email, password },
      returnHeaders: true,
    })
    const cookie = collectCookies(signInHeaders)
    assert.ok(cookie.includes('session'), 'expected a session cookie from signInEmail')

    // DCR over HTTP (what a connector does).
    const reg = await fetch(`${base}/oauth2/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: publicUrl },
      body: JSON.stringify({
        client_name: 'spike-mcp-client',
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'openid mcp:read offline_access',
      }),
    })
    assert.equal(reg.status, 200, `DCR failed: ${reg.status} ${await reg.clone().text()}`)
    const clientId = (await reg.json()).client_id
    assert.ok(clientId, 'DCR returned no client_id')

    const state = b64url(randomBytes(8))
    const authorizeUrl = new URL(`${base}/oauth2/authorize`)
    authorizeUrl.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: 'openid mcp:read offline_access',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      resource: mcpUrl,
    }).toString()

    // better-auth signals redirects two ways: a real 3xx with a Location header,
    // OR a 200 JSON body `{ redirect: true, url }` (its default when the caller
    // doesn't opt into hard redirects). `redirectTarget` normalizes both.
    const redirectTarget = async (res) => {
      if (res.status >= 300 && res.status < 400) return res.headers.get('location')
      if (res.headers.get('content-type')?.includes('application/json')) {
        const j = await res
          .clone()
          .json()
          .catch(() => null)
        if (j && j.redirect === true && typeof j.url === 'string') return j.url
        if (j && typeof j.redirect_uri === 'string') return j.redirect_uri
        if (j && typeof j.redirectURI === 'string') return j.redirectURI
      }
      return null
    }

    // First authorize → likely /consent?<signed oauth_query>. The consent
    // endpoint reads the pending request from the SIGNED query string echoed
    // back in its `oauth_query` body field (a `before` hook verifies the sig and
    // repopulates oAuthState), then completes the authorization ITSELF and
    // returns the redirect to the client (with the code) — no re-authorize.
    const redirected = await fetch(authorizeUrl, { headers: { cookie }, redirect: 'manual' })
    let target = await redirectTarget(redirected)
    if (target?.includes('/consent')) {
      const oauthQuery = target.split('?', 2)[1] ?? ''
      const consentRes = await fetch(`${base}/oauth2/consent`, {
        method: 'POST',
        // Origin must be a trusted origin — better-auth CSRF-guards state-changing
        // POSTs. The spike AS trusts baseURL (== publicUrl) by default.
        headers: { cookie, 'content-type': 'application/json', origin: publicUrl },
        redirect: 'manual',
        body: JSON.stringify({ accept: true, oauth_query: oauthQuery }),
      })
      target = await redirectTarget(consentRes)
      assert.ok(target !== null, `consent did not redirect: ${consentRes.status} ${await consentRes.clone().text()}`)
    }
    assert.ok(target !== null, `authorize did not redirect: ${redirected.status} ${await redirected.clone().text()}`)
    const code = new URL(target, base).searchParams.get('code')
    assert.ok(code, `no authorization code in redirect: ${target}`)

    const tokenRes = await fetch(`${base}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: publicUrl },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: codeVerifier,
        resource: mcpUrl, // ← flips isJwtAccessToken on
      }).toString(),
    })
    assert.equal(tokenRes.status, 200, `token exchange failed: ${tokenRes.status} ${await tokenRes.clone().text()}`)
    const accessToken = (await tokenRes.json()).access_token
    assert.ok(accessToken, 'no access_token in token response')
    assert.equal(
      accessToken.split('.').length,
      3,
      'access_token is opaque, not a JWT — resource did not trigger signing',
    )

    const jwks = createRemoteJWKSet(new URL(`${base}/jwks`))
    // jwtVerify with `audience: mcpUrl` ALREADY enforces that mcpUrl is a member
    // of the token's `aud` (jose accepts a string or an array containing it).
    // The `openid` scope makes the AS add the userinfo endpoint as a second
    // audience, so `aud` is an array — assert membership, not string equality.
    const { payload, protectedHeader } = await jwtVerify(accessToken, jwks, { issuer: base, audience: mcpUrl })

    const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    assert.ok(audList.includes(mcpUrl), `aud does not include MCP resource: ${JSON.stringify(payload.aud)}`)
    assert.ok(typeof payload.sub === 'string' && payload.sub.length > 0, 'missing sub')
    assert.ok(String(payload.scope ?? '').includes('mcp:read'), 'scope not carried into JWT')

    console.log('SPIKE PASSED', {
      alg: protectedHeader.alg,
      aud: payload.aud,
      sub: payload.sub,
      scope: payload.scope,
    })
  } finally {
    live.server.close()
  }
}

main().catch((e) => {
  console.error('SPIKE FAILED\n', e)
  process.exit(1)
})
