// test/e2e/admin-panel.test.ts
//
// Drives the admin router over real HTTP: the CSP header on every response, the
// pre-gate htmx asset, the session gate (403 non-admin / redirect anonymous),
// the same-origin CSRF guard, the error middleware (a rejecting handler → 500,
// not a crash/hang), and — for an admin session — the dashboard + bases pages
// rendering DB state. The better-auth session is stubbed (a controllable
// `getSession`) so the test stays hermetic; the full OAuth login flow is covered
// by the other e2e specs.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ReadPool } from '@1c-odata/mcp/internal'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auth } from '../../src/auth/better-auth.js'
import { createAdminRouter } from '../../src/http/admin/router.js'
import { loadKeyring } from '../../src/store/crypto.js'
import { createDb, type DbHandle } from '../../src/store/db.js'
import { runAuthMigrations } from '../../src/store/migrate.js'
import { BaseRepo } from '../../src/store/repos.js'

const KEY = Buffer.alloc(32, 5).toString('base64')

let handle: DbHandle
let server: Server
let origin: string
const session = { value: null as unknown }
// Swappable stubs for the better-auth admin API so a test can force a rejection.
// Typed with an explicit arg bag so `.mock.calls[0][0].headers` is inspectable.
type ApiArg = { headers?: unknown; body?: unknown; query?: unknown }
const listUsers = vi.fn(async (_arg?: ApiArg) => ({ users: [] as unknown[] }))
const createUserApi = vi.fn(async (_arg?: ApiArg) => ({ user: { id: 'x', email: 'x@x', name: 'X', role: 'user' } }))

beforeEach(async () => {
  handle = createDb({ kind: 'pglite' })
  await runAuthMigrations(handle)
  await new BaseRepo(handle.db).upsert('trade', {
    baseUrl: 'http://1c/odata',
    login: 'u',
    serverTimezone: 'Europe/Moscow',
  })
  const keyring = loadKeyring({ ONEC_MCP_ENC_KEY: KEY } as NodeJS.ProcessEnv)
  const sharedPool: ReadPool = { get: vi.fn(), list: vi.fn(), refresh: vi.fn() }
  listUsers.mockReset().mockResolvedValue({ users: [] })
  createUserApi.mockReset().mockResolvedValue({ user: { id: 'x', email: 'x@x', name: 'X', role: 'user' } })
  const auth = {
    api: {
      getSession: vi.fn().mockImplementation(async () => session.value),
      listUsers,
      createUser: createUserApi,
    },
  } as unknown as Auth

  const app = express()
  app.use(express.json())
  const publicUrl = 'http://127.0.0.1'
  app.use('/admin', createAdminRouter({ auth, db: handle.db, keyring, sharedPool, version: '9.9.9', publicUrl }))
  server = createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address() as AddressInfo
  origin = `http://127.0.0.1:${addr.port}`
})

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await handle.close()
})

describe('admin panel over HTTP', () => {
  it('serves vendored htmx before the gate, with a long cache + CSP', async () => {
    session.value = null // anonymous — asset must still load
    const res = await fetch(`${origin}/admin/assets/htmx.min.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(res.headers.get('cache-control')).toContain('immutable')
    const body = await res.text()
    expect(body).toContain('htmx') // real minified source, not a placeholder
    expect(body.length).toBeGreaterThan(10_000)
  })

  it('pins a script-locked CSP (script-src self, no unsafe-inline)', async () => {
    session.value = { user: { role: 'admin' }, session: {} }
    const res = await fetch(`${origin}/admin`)
    const csp = res.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("script-src 'self'")
    // The script vector must NOT allow inline execution (stored-XSS containment).
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/)
  })

  it('redirects an anonymous browser to sign-in', async () => {
    session.value = null
    const res = await fetch(`${origin}/admin`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('/sign-in')
  })

  it('403s an authenticated non-admin', async () => {
    session.value = { user: { role: 'user' }, session: {} }
    const res = await fetch(`${origin}/admin/bases`)
    expect(res.status).toBe(403)
  })

  it('renders the dashboard for an admin, with the CSP header', async () => {
    session.value = { user: { role: 'admin' }, session: {} }
    const res = await fetch(`${origin}/admin`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    const html = await res.text()
    expect(html).toContain('Dashboard')
    expect(html).toContain('DB-backed')
    expect(html).toContain('/admin/assets/htmx.min.js')
  })

  it('renders the bases list from DB state for an admin', async () => {
    session.value = { user: { role: 'admin' }, session: {} }
    const res = await fetch(`${origin}/admin/bases`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('trade')
    expect(html).toContain('http://1c/odata')
  })

  describe('CSRF same-origin guard', () => {
    it('rejects a cross-origin POST (wrong Origin) with 403', async () => {
      session.value = { user: { role: 'admin' }, session: {} }
      const res = await fetch(`${origin}/admin/users`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example.com' },
        body: 'email=e@x&password=p&role=user',
      })
      expect(res.status).toBe(403)
      expect(createUserApi).not.toHaveBeenCalled()
    })

    it('rejects an unsafe method with NO Origin/Referer', async () => {
      session.value = { user: { role: 'admin' }, session: {} }
      const res = await fetch(`${origin}/admin/users`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'email=e@x&password=p&role=user',
      })
      expect(res.status).toBe(403)
    })

    it('passes a same-origin POST through the CSRF check to the handler', async () => {
      session.value = { user: { role: 'admin' }, session: {} }
      const res = await fetch(`${origin}/admin/users`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1' },
        body: 'email=e@x&password=p&role=user',
      })
      expect(res.status).toBe(200)
      expect(createUserApi).toHaveBeenCalledTimes(1)
    })
  })

  describe('plugin-level authz (second layer)', () => {
    it('forwards the admin session headers to createUser so the plugin can authorize', async () => {
      session.value = { user: { role: 'admin' }, session: {} }
      await fetch(`${origin}/admin/users`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'http://127.0.0.1',
          cookie: 'sess=abc',
        },
        body: 'email=e@x&password=p&role=admin',
      })
      expect(createUserApi).toHaveBeenCalledTimes(1)
      const arg = createUserApi.mock.calls[0]?.[0] as { headers?: unknown } | undefined
      // Headers were forwarded (a Headers instance from fromNodeHeaders) — this is
      // what lets better-auth's admin() plugin run its OWN admin-session check.
      expect(arg?.headers).toBeInstanceOf(Headers)
      expect((arg?.headers as Headers).get('cookie')).toContain('sess=abc')
    })
  })

  describe('error middleware', () => {
    it('a rejecting handler yields a 500, not a crash/hang', async () => {
      session.value = { user: { role: 'admin' }, session: {} }
      createUserApi.mockRejectedValueOnce(new Error('duplicate email'))
      const res = await fetch(`${origin}/admin/users`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1' },
        body: 'email=e@x&password=p&role=user',
      })
      expect(res.status).toBe(500)
      const body = await res.text()
      expect(body).toContain('Internal error')
      expect(body).not.toContain('duplicate email') // raw error never leaks to the DOM
    })
  })
})
