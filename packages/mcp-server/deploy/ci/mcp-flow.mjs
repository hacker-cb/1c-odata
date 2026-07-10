#!/usr/bin/env node
// deploy/ci/mcp-flow.mjs
//
// A headless MCP connector: the full browser-less OAuth 2.1 dance a real Claude
// connector performs, then a POST /mcp `initialize`, driven twice to prove the
// server's DNS-rebinding Host guard is live END-TO-END through whatever fronts it.
//
// It exists so CI can assert the ONE seam no cheaper test reaches: on `/mcp` the
// bearer gate runs BEFORE the DNS-rebinding Host guard, so the guard is only
// reachable WITH a valid token — every Host assertion must be bearer-driven. An
// unauthenticated `curl /mcp` is a 401 and proves nothing.
//
// Deliberately dependency-free (global fetch only) so it runs against the shipped
// `--prod` deploy tree, which has no dev deps. It mirrors the OAuth flow in
// test/e2e/_harness.ts::runFlow; that suite is the authoritative version — keep
// the two in step. In particular the initialize POST MUST send
//   Accept: application/json, text/event-stream
// or the Streamable-HTTP transport answers 406, not 200 (a positive-case break
// that is easy to misread as a Host-guard bug).
//
// Usage:
//   node mcp-flow.mjs <publicUrl> <email> <password> --host-ok <host> [--host-evil <host>]
// Asserts:
//   --host-ok   → initialize returns 200 + an Mcp-Session-Id header
//   --host-evil → the SAME request with a spoofed Host returns exactly 403 (OPTIONAL:
//                 meaningful only DIRECT to the app — through a proxy it tests the
//                 proxy's own host routing, not this server's guard, so Tier 3 omits it)
// A NODE_EXTRA_CA_CERTS env var (set by the caller) covers the TLS case behind a
// proxy terminating with a private CA; node:https honors it by default.
//
// The initialize POST uses node:http/https, NOT fetch: `Host` is a forbidden
// header name for fetch/undici (silently dropped), so a spoofed-Host request over
// fetch would carry the REAL host and the negative assertion would be inert. Raw
// node:http sends exactly the Host we set; SNI stays the real hostname for TLS.

import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

const b64url = (buf) => Buffer.from(buf).toString('base64url')

function arg(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const [publicUrl, email, password] = process.argv.slice(2)
const hostOk = arg('--host-ok')
const hostEvil = arg('--host-evil') // optional — see the negative-case note above
if (!publicUrl || !email || !password || !hostOk) {
  console.error('usage: mcp-flow.mjs <publicUrl> <email> <password> --host-ok <host> [--host-evil <host>]')
  process.exit(2)
}

const base = `${publicUrl}/api/auth` // better-auth mount
const mcpUrl = `${publicUrl}/mcp`
const resource = mcpUrl // RFC 8707 resource → JWT aud
const redirectUri = 'http://127.0.0.1:9999/callback' // never dereferenced (headless)
const scope = 'openid mcp:read offline_access'

const fail = (msg) => {
  console.error(`mcp-flow: ${msg}`)
  process.exit(1)
}

// better-auth signals a redirect either as a 3xx Location or a 200 JSON {redirect,url}.
async function redirectTarget(res) {
  if (res.status >= 300 && res.status < 400) return res.headers.get('location')
  if (res.headers.get('content-type')?.includes('application/json')) {
    const j = await res
      .clone()
      .json()
      .catch(() => null)
    if (j?.redirect === true && typeof j.url === 'string') return j.url
    if (typeof j?.redirect_uri === 'string') return j.redirect_uri
    if (typeof j?.redirectURI === 'string') return j.redirectURI
  }
  return null
}

async function mintToken() {
  const codeVerifier = b64url(randomBytes(32))
  const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest())

  // Sign in → session cookie.
  const signIn = await fetch(`${base}/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: publicUrl },
    body: JSON.stringify({ email, password }),
  })
  if (signIn.status !== 200) fail(`sign-in failed: ${signIn.status} ${await signIn.text()}`)
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(';', 1)[0])
    .join('; ')

  // Dynamic Client Registration (what an MCP connector does).
  const reg = await fetch(`${base}/oauth2/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: publicUrl },
    body: JSON.stringify({
      client_name: 'ci-mcp-flow',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope,
    }),
  })
  if (reg.status !== 200) fail(`DCR failed: ${reg.status} ${await reg.text()}`)
  const clientId = (await reg.json()).client_id

  const authorizeUrl = new URL(`${base}/oauth2/authorize`)
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state: b64url(randomBytes(8)),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    resource,
  }).toString()

  // authorize → /consent?<signed query>; the consent POST completes the grant.
  const authorized = await fetch(authorizeUrl, { headers: { cookie }, redirect: 'manual' })
  let target = await redirectTarget(authorized)
  if (target?.includes('/consent')) {
    const oauthQuery = target.split('?', 2)[1] ?? ''
    const consent = await fetch(`${base}/oauth2/consent`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: publicUrl },
      redirect: 'manual',
      body: JSON.stringify({ accept: true, oauth_query: oauthQuery }),
    })
    target = await redirectTarget(consent)
    if (target === null) fail(`consent did not redirect: ${consent.status} ${await consent.text()}`)
  }
  if (target === null) fail(`authorize did not redirect: ${authorized.status}`)
  const code = new URL(target, base).searchParams.get('code')
  if (code === null) fail(`no code in redirect: ${target}`)

  const tokenRes = await fetch(`${base}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: publicUrl },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
      resource,
    }).toString(),
  })
  if (tokenRes.status !== 200) fail(`token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`)
  const accessToken = (await tokenRes.json()).access_token
  if (!accessToken) fail('no access_token in token response')
  return accessToken
}

// POST /mcp initialize with an explicit Host header, over node:http(s) so the Host
// we set is the Host actually sent. Resolves { status, sessionId }.
function initialize(token, hostHeader) {
  const u = new URL(mcpUrl)
  const isTls = u.protocol === 'https:'
  const mod = isTls ? https : http
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'ci-mcp-flow', version: '0.0.0' },
    },
  })
  const opts = {
    method: 'POST',
    hostname: u.hostname,
    port: u.port || (isTls ? 443 : 80),
    path: u.pathname,
    headers: {
      authorization: `Bearer ${token}`,
      // Dual Accept is MANDATORY — the Streamable-HTTP transport 406s without it.
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      host: hostHeader, // node:http sends this verbatim (fetch would forbid it)
    },
    // Keep TLS SNI + cert validation pinned to the REAL hostname even when the Host
    // header is spoofed, so only the app-level guard — not TLS — rejects it.
    ...(isTls ? { servername: u.hostname } : {}),
  }
  return new Promise((resolve, reject) => {
    const req = mod.request(opts, (res) => {
      res.resume() // drain; we only need status + headers
      resolve({ status: res.statusCode, sessionId: res.headers['mcp-session-id'] })
    })
    // node:http has NO default timeout — bound a server that accepts the socket but
    // never responds, so this fails fast instead of hanging the CI job.
    req.setTimeout(15000, () => req.destroy(new Error('initialize timed out')))
    req.on('error', reject)
    req.end(body)
  })
}

const token = await mintToken()

// Good Host → 200 + a session id (proves the guard ADMITS the canonical host and
// the whole authed path works end-to-end, incl. through a Host-preserving proxy).
const good = await initialize(token, hostOk)
if (good.status !== 200) fail(`--host-ok expected 200, got ${good.status}`)
if (!good.sessionId) fail('--host-ok: no Mcp-Session-Id header on the 200')

// Spoofed Host → exactly 403 (only asserted DIRECT to the app; a downgrade to a
// generic 400/401 would be distinguishable and is failed).
if (hostEvil !== undefined) {
  const evil = await initialize(token, hostEvil)
  if (evil.status !== 403) fail(`--host-evil expected 403, got ${evil.status}`)
  console.log(`mcp-flow OK: initialize 200 for Host=${hostOk} (session issued), 403 for Host=${hostEvil}`)
} else {
  console.log(`mcp-flow OK: initialize 200 for Host=${hostOk} (session issued)`)
}
