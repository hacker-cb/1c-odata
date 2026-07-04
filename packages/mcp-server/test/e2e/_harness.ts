// test/e2e/_harness.ts
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ConnectionPool, type ConnectionSource } from '@1c-odata/mcp/internal'
import { PGlite } from '@electric-sql/pglite'
import { pushSchema } from 'drizzle-kit/api'
import { drizzle } from 'drizzle-orm/pglite'
import { buildAuth } from '../../src/auth/better-auth.js'
import { resolveCanonicalUrls } from '../../src/auth/config.js'
import { createApp } from '../../src/http/app.js'
import { createAuthMount } from '../../src/http/auth-mount.js'
import { buildMcpServer } from '../../src/server-factory.js'
import * as schema from '../../src/store/schema.js'

const REDIRECT_URI = 'http://127.0.0.1:9999/callback' // never dereferenced (headless)

const b64url = (buf: Buffer): string => buf.toString('base64url')

export interface AuthHarness {
  /** `${publicUrl}/api/auth` — the OAuth issuer. */
  base: string
  publicUrl: string
  /** `${publicUrl}/mcp` — the JWT `aud` when `resource` is sent. */
  mcpUrl: string
  /** The live better-auth instance (shared with the app so keys + issuer match). */
  // biome-ignore lint/suspicious/noExplicitAny: the inferred betterAuth() type is not portable; only structural use here.
  auth: any
  /**
   * Run createUser(admin)→signIn→DCR→authorize(+consent)→token. Sends `resource`
   * on BOTH authorize and token when provided → a signed JWT; omit it → an opaque
   * token.
   */
  mintToken(o?: { resource?: string; scope?: string }): Promise<string>
  close(): Promise<void>
}

/**
 * Provision a user through the admin() plugin's trusted server path (header-less,
 * so the create-check is skipped — the same path `admin-create` uses). Public
 * self-service sign-up is disabled in production (`disableSignUp: true`), so tests
 * must create users this way rather than POSTing /sign-up/email.
 */
export async function createTestUser(
  // biome-ignore lint/suspicious/noExplicitAny: the inferred betterAuth() type is not portable; only structural use here.
  auth: any,
  o: { email: string; password: string; name?: string },
): Promise<void> {
  await auth.api.createUser({
    body: { email: o.email, password: o.password, name: o.name ?? 'E2E', role: 'user' },
  })
}

/**
 * All the state-changing OAuth POSTs a browser client would make, carrying Origin
 * for CSRF. The user is provisioned through the admin plugin (`auth`) — public
 * sign-up is disabled — then signed IN over HTTP to obtain the session cookie.
 */
export async function runFlow(
  base: string,
  publicUrl: string,
  // biome-ignore lint/suspicious/noExplicitAny: the inferred betterAuth() type is not portable; only structural use here.
  auth: any,
  opts: { resource?: string; scope?: string },
): Promise<string> {
  const scope = opts.scope ?? 'openid mcp:read offline_access'
  const email = `user-${b64url(randomBytes(6))}@example.com`
  const password = 'Password123!'
  const codeVerifier = b64url(randomBytes(32))
  const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest())

  // Provision the user via the admin plugin (self-service sign-up is disabled),
  // then sign in over HTTP to obtain the session cookie.
  await createTestUser(auth, { email, password })
  const signIn = await fetch(`${base}/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: publicUrl },
    body: JSON.stringify({ email, password }),
  })
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(';', 1)[0])
    .join('; ')

  // Dynamic Client Registration (what an MCP connector does).
  const reg = await fetch(`${base}/oauth2/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: publicUrl },
    body: JSON.stringify({
      client_name: 'e2e-mcp-client',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope,
    }),
  })
  if (reg.status !== 200) throw new Error(`DCR failed: ${reg.status} ${await reg.text()}`)
  const clientId: string = (await reg.json()).client_id

  const authorizeUrl = new URL(`${base}/oauth2/authorize`)
  const authorizeParams: Record<string, string> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope,
    state: b64url(randomBytes(8)),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }
  if (opts.resource !== undefined) authorizeParams.resource = opts.resource
  authorizeUrl.search = new URLSearchParams(authorizeParams).toString()

  // better-auth signals redirects either as a 3xx (Location) or a 200 JSON
  // `{ redirect: true, url }`; also accept `redirect_uri`/`redirectURI`.
  const redirectTarget = async (res: Response): Promise<string | null> => {
    if (res.status >= 300 && res.status < 400) return res.headers.get('location')
    if (res.headers.get('content-type')?.includes('application/json')) {
      const j = (await res
        .clone()
        .json()
        .catch(() => null)) as Record<string, unknown> | null
      if (j && j.redirect === true && typeof j.url === 'string') return j.url
      if (j && typeof j.redirect_uri === 'string') return j.redirect_uri
      if (j && typeof j.redirectURI === 'string') return j.redirectURI
    }
    return null
  }

  // First authorize → /consent?<signed oauth_query>. The consent endpoint reads
  // the pending request from the signed query echoed back in `oauth_query` (a
  // before-hook re-verifies the sig), then completes the authorization ITSELF
  // and returns the client redirect (with the code).
  const redirected = await fetch(authorizeUrl, { headers: { cookie }, redirect: 'manual' })
  let target = await redirectTarget(redirected)
  if (target?.includes('/consent')) {
    const oauthQuery = target.split('?', 2)[1] ?? ''
    const consentRes = await fetch(`${base}/oauth2/consent`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: publicUrl },
      redirect: 'manual',
      body: JSON.stringify({ accept: true, oauth_query: oauthQuery }),
    })
    target = await redirectTarget(consentRes)
    if (target === null) throw new Error(`consent did not redirect: ${consentRes.status} ${await consentRes.text()}`)
  }
  if (target === null) throw new Error(`authorize did not redirect: ${redirected.status} ${await redirected.text()}`)
  const code = new URL(target, base).searchParams.get('code')
  if (code === null) throw new Error(`no authorization code in redirect: ${target}`)

  const tokenBody: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: codeVerifier,
  }
  if (opts.resource !== undefined) tokenBody.resource = opts.resource // flips JWT signing on
  const tokenRes = await fetch(`${base}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: publicUrl },
    body: new URLSearchParams(tokenBody).toString(),
  })
  if (tokenRes.status !== 200) throw new Error(`token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`)
  const accessToken: string | undefined = (await tokenRes.json()).access_token
  if (accessToken === undefined) throw new Error('no access_token in token response')
  return accessToken
}

/**
 * Serve a MUTABLE better-auth handler over a real loopback socket. Binds ONCE on
 * an ephemeral port and returns immediately (handler starts as a 503 stub, set
 * later via `setHandler`).
 *
 * This is what avoids the probe→close→rebind race: the AS's `iss`/`aud` default
 * to its `baseURL`, which must equal the listening origin — but instead of
 * grabbing a port from a throwaway socket, closing it, and racing to rebind the
 * real AS on that same port (a window another parallel worker can steal, →
 * EADDRINUSE flake), we bind once, learn the port, build the AS for that port,
 * then install its handler. No window exists.
 */
function serveSwappable(): Promise<{
  server: Server
  publicUrl: string
  setHandler(h: (request: Request) => Promise<Response>): void
}> {
  let active: ((request: Request) => Promise<Response>) | undefined
  const server = createServer(async (req, res) => {
    if (active === undefined) {
      res.writeHead(503)
      res.end()
      return
    }
    const url = `http://${req.headers.host}${req.url}`
    const method = req.method ?? 'GET'
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined
    const request = new Request(url, {
      method,
      headers: req.headers as Record<string, string>,
      ...(body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
    })
    const response = await active(request)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(response.body !== null ? Buffer.from(await response.arrayBuffer()) : undefined)
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        server,
        publicUrl: `http://127.0.0.1:${port}`,
        setHandler(h) {
          active = h
        },
      })
    }),
  )
}

/**
 * Boot an ephemeral AS on a loopback port (race-free — see {@link serveSwappable}).
 * `extraResourcePaths` (e.g. `['/other']`, resolved against `base` once the port
 * is known) widen `validAudiences` so the wrong-aud test can mint a token for a
 * different, but AS-permitted, resource.
 */
export async function startAuthServer(extraResourcePaths: string[] = []): Promise<AuthHarness> {
  const srv = await serveSwappable()
  const publicUrl = srv.publicUrl
  const mcpUrl = `${publicUrl}/mcp`
  const base = `${publicUrl}/api/auth`
  const extraAudiences = extraResourcePaths.map((p) => `${base}${p}`)
  // Use the REAL production buildAuth (not a hand-copied plugin set) so this e2e
  // doubles as a schema-drift guard: the committed auth-schema.ts is pushed below,
  // and if a plugin is added to buildAuth without regenerating the schema, the
  // authorize→consent→token flow touches a missing table and the test fails.
  const db = drizzle(new PGlite(), { schema })
  const auth = buildAuth({
    urls: resolveCanonicalUrls(publicUrl),
    db,
    secret: 'e2e-secret-not-for-prod-0123456789',
    extraAudiences,
  })
  const { apply } = await pushSchema(schema as Record<string, unknown>, db as never)
  await apply()
  srv.setHandler((req) => auth.handler(req))

  return {
    base,
    publicUrl,
    mcpUrl,
    auth,
    mintToken: (o = {}) => runFlow(base, publicUrl, auth, o),
    async close() {
      await new Promise<void>((r) => srv.server.close(() => r()))
    },
  }
}

const MINI_EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <EntityType Name="Catalog_X">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
        <Property Name="Code" Type="Edm.String" Nullable="false" MaxLength="3"/>
      </EntityType>
      <EntityContainer Name="StandardODATA" m:IsDefaultEntityContainer="true">
        <EntitySet Name="Catalog_X" EntityType="StandardODATA.Catalog_X"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`

/** A minimal REAL 1С OData stub on a loopback port (mirrors mcp-endpoint.test.ts). */
function startUpstream(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?', 1)[0]
    if (path === '/odata/$metadata') {
      res.writeHead(200, { 'Content-Type': 'application/xml' })
      res.end(MINI_EDMX)
      return
    }
    if (path === '/odata/Catalog_X') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ 'odata.metadata': 'm', value: [{ Ref_Key: 'a', Code: 'RUB' }] }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/odata` })
    })
  })
}

export interface AppWithAuth {
  appBase: string // http://127.0.0.1:<port>
  mcpUrl: string // `${appBase}/mcp`
  close(): Promise<void>
}

/**
 * Boot the full Express app WITH auth, gated by a bearer verifier whose issuer is
 * the harness AS. The app SHARES the harness's better-auth instance (same signing
 * keys, same issuer, same JWKS) so tokens the harness mints verify against the
 * app's gate. Two-phase bound to a fixed port so `publicUrl` matches the socket.
 *
 * Host allowlist is disabled (no `allowedHosts`) so the DNS-rebinding guard does
 * not pre-empt the auth gate we are testing.
 */
export async function startAppWithAuth(as: AuthHarness): Promise<AppWithAuth> {
  const upstream = await startUpstream()
  const source: ConnectionSource = {
    async getBase(name) {
      return name === 'demo' ? { baseUrl: upstream.baseUrl, login: 'u', serverTimezone: 'UTC' } : undefined
    },
    async listBases() {
      return [{ name: 'demo', baseUrl: upstream.baseUrl, login: 'u', serverTimezone: 'UTC' }]
    },
    async getSecret() {
      return 'p'
    },
    async secretSource() {
      return 'env'
    },
  }
  const pool = new ConnectionPool(source)

  // Grab a free port, then bind the app there so its publicUrl matches the socket.
  const probe = createServer()
  const appPort = await new Promise<number>((resolve) =>
    probe.listen(0, '127.0.0.1', () => resolve((probe.address() as AddressInfo).port)),
  )
  await new Promise<void>((r) => probe.close(() => r()))

  const appPublicUrl = `http://127.0.0.1:${appPort}`
  const urls = resolveCanonicalUrls(appPublicUrl)
  // The token's `aud` is the HARNESS resource id (`as.mcpUrl`), and its `iss` is
  // the harness AS (`as.base`, which owns the keys + JWKS). Pin the gate to those
  // so a token the harness mints for `as.mcpUrl` verifies against the app.
  const gateUrls = { ...urls, issuer: as.base, mcpResourceUrl: as.mcpUrl }
  const { authRouter, bearerMiddleware } = createAuthMount({ auth: as.auth, urls: gateUrls })

  const app = createApp({
    buildServer: () => buildMcpServer(pool, { version: '9.9.9', dataDir: '/synthetic' }),
    auth: { auth: as.auth, urls: gateUrls, authRouter, bearerMiddleware },
  })
  const server = app.listen(appPort, '127.0.0.1')
  await new Promise<void>((r) => server.once('listening', r))

  return {
    appBase: appPublicUrl,
    mcpUrl: as.mcpUrl,
    async close() {
      await new Promise<void>((r) => server.close(() => r()))
      await new Promise<void>((r) => upstream.server.close(() => r()))
    },
  }
}
