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
    expect(html).toContain('badge') // health badge column
    expect(html).toContain('rel="icon"') // inline SVG favicon in the head
    expect(html).toContain('data:image/svg+xml')
  })

  it('the base form is a timezone <select>, not a free-text input, with a Cancel', async () => {
    session.value = { user: { role: 'admin' }, session: {} }
    const html = await (await fetch(`${origin}/admin/bases/new`)).text()
    expect(html).toContain('<select name="serverTimezone"')
    expect(html).toContain('Europe/Moscow') // an IANA option is rendered
    expect(html).toContain('/admin/ui/close') // Cancel clears the form slot
    expect(html).not.toContain('name="serverTimezone" value=') // no free-text field
  })

  it("the edit form preselects the base's stored timezone", async () => {
    session.value = { user: { role: 'admin' }, session: {} }
    const html = await (await fetch(`${origin}/admin/bases/trade/edit`)).text()
    // trade was seeded with Europe/Moscow — its option must carry selected.
    expect(html).toMatch(/<option selected>Europe\/Moscow<\/option>/)
  })

  it('shows empty-state placeholders when there are no rows', async () => {
    session.value = { user: { role: 'admin' }, session: {} }
    listUsers.mockResolvedValueOnce({ users: [] })
    const usersHtml = await (await fetch(`${origin}/admin/users`)).text()
    expect(usersHtml).toContain('No users yet')
  })

  describe('CSRF same-origin guard', () => {
    it('rejects a cross-origin POST (wrong Origin) with 403', async () => {
      session.value = { user: { role: 'admin' }, session: {} }
      const res = await fetch(`${origin}/admin/users`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example.com' },
        body: 'email=e@x&password=valid-pass-1&role=user',
      })
      expect(res.status).toBe(403)
      expect(createUserApi).not.toHaveBeenCalled()
    })

    it('rejects an unsafe method with NO Origin/Referer', async () => {
      session.value = { user: { role: 'admin' }, session: {} }
      const res = await fetch(`${origin}/admin/users`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'email=e@x&password=valid-pass-1&role=user',
      })
      expect(res.status).toBe(403)
    })

    it('passes a same-origin POST through the CSRF check to the handler', async () => {
      session.value = { user: { role: 'admin' }, session: {} }
      const res = await fetch(`${origin}/admin/users`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1' },
        body: 'email=e@x&password=valid-pass-1&role=user',
      })
      expect(res.status).toBe(200)
      expect(createUserApi).toHaveBeenCalledTimes(1)
    })
  })

  describe('required-field validation', () => {
    it('a same-origin POST with a missing password is a 400, createUser not called', async () => {
      session.value = { user: { role: 'admin' }, session: {} }
      const res = await fetch(`${origin}/admin/users`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1' },
        body: 'email=e@x&role=user', // password omitted → must not coerce to "undefined"
      })
      expect(res.status).toBe(400)
      expect(await res.text()).toContain('Password must be at least 8 characters')
      expect(createUserApi).not.toHaveBeenCalled()
    })

    it('a too-short password is a clean 400 (not a 500 from better-auth)', async () => {
      session.value = { user: { role: 'admin' }, session: {} }
      const res = await fetch(`${origin}/admin/users`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1' },
        body: 'email=e@x&password=short&role=user', // 5 chars < 8
      })
      expect(res.status).toBe(400)
      expect(await res.text()).toContain('at least 8 characters')
      expect(createUserApi).not.toHaveBeenCalled()
    })
  })

  it('a multi-role "admin,user" user shows the admin option selected, not the first', async () => {
    session.value = { user: { id: 'a1', email: 'admin@x', role: 'admin' }, session: {} }
    listUsers.mockResolvedValueOnce({
      users: [{ id: 'm1', email: 'multi@x', name: 'M', role: 'admin,user', banned: false }],
    })
    const html = await (await fetch(`${origin}/admin/users`)).text()
    // The admin <option> must carry `selected` — a bare `role==='admin'` check would
    // miss "admin,user" and default the dropdown to `user`, misrepresenting the row.
    expect(html).toMatch(/<option value="admin" selected>/)
    expect(html).not.toMatch(/<option value="user" selected>/)
  })

  describe('user management surface', () => {
    it('serves the panel helper script (generator/copy) before the gate', async () => {
      session.value = null // /account pages for plain users load it too
      const res = await fetch(`${origin}/admin/assets/admin.js`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('javascript')
      const body = await res.text()
      expect(body).toContain('data-gen-password')
      expect(body).toContain('getRandomValues')
    })

    it('renders rows with status, created date, self marker and row actions', async () => {
      session.value = { user: { id: 'a1', email: 'admin@x', role: 'admin' }, session: {} }
      listUsers.mockResolvedValueOnce({
        users: [
          {
            id: 'a1',
            email: 'admin@x',
            name: 'Admin',
            role: 'admin',
            banned: false,
            createdAt: new Date('2026-01-02T03:04:05Z'),
          },
          { id: 'u2', email: 'user@x', name: 'U', role: 'user', banned: true },
        ],
      })
      const html = await (await fetch(`${origin}/admin/users`)).text()
      expect(html).toContain('class="you"') // self marker on the acting admin's row
      expect(html).toContain('badge banned')
      expect(html).toContain('2026-01-02')
      expect(html).toContain('/admin/users/u2/password')
      expect(html).toContain('/admin/users/u2/unban') // banned row offers Unban
      expect(html).not.toContain('/admin/users/a1/ban') // no self-ban/delete affordances
      expect(html).not.toContain(`hx-delete="/admin/users/a1"`)
      expect(html).toContain('data-gen-password="#create-user-pw"') // generator on the create form
    })

    it('the nav carries the account chip + sign-out for the signed-in admin', async () => {
      session.value = { user: { id: 'a1', email: 'admin@x', role: 'admin' }, session: {} }
      const html = await (await fetch(`${origin}/admin`)).text()
      expect(html).toContain('href="/account"')
      expect(html).toContain('admin@x')
      expect(html).toContain('action="/account/sign-out"')
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
        body: 'email=e@x&password=valid-pass-1&role=admin',
      })
      expect(createUserApi).toHaveBeenCalledTimes(1)
      const arg = createUserApi.mock.calls[0]?.[0] as { headers?: unknown } | undefined
      // Headers were forwarded (a Headers instance from fromNodeHeaders) — this is
      // what lets better-auth's admin() plugin run its OWN admin-session check.
      expect(arg?.headers).toBeInstanceOf(Headers)
      expect((arg?.headers as Headers).get('cookie')).toContain('sess=abc')
    })
  })

  describe('error visibility (flash toasts)', () => {
    it('the app shell carries the htmx error-swap config and the #flash region', async () => {
      session.value = { user: { role: 'admin' }, session: {} }
      const res = await fetch(`${origin}/admin`)
      const html = await res.text()
      // htmx 2.x default drops 4xx/5xx bodies — the config override is what makes
      // every flash-toast test below reach the DOM in a real browser.
      expect(html).toContain('name="htmx-config"')
      expect(html).toContain('"[45].."')
      expect(html).toContain('id="flash"')
    })

    it('a validation 400 renders an OOB flash and suppresses the target swap', async () => {
      session.value = { user: { role: 'admin' }, session: {} }
      const res = await fetch(`${origin}/admin/users`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1' },
        body: 'email=e@x&role=user', // password omitted
      })
      expect(res.status).toBe(400)
      // The request's own target must NOT swap (an error <p> appended into a
      // <tbody>, or an outerHTML row delete for a failed DELETE) — only the toast.
      expect(res.headers.get('hx-reswap')).toBe('none')
      const body = await res.text()
      expect(body).toContain('hx-swap-oob')
      expect(body).toContain('id="flash"')
    })

    it('a 500 on an htmx request renders an OOB flash (not a bare unswapped fragment)', async () => {
      session.value = { user: { role: 'admin' }, session: {} }
      createUserApi.mockRejectedValueOnce(new Error('duplicate email'))
      const res = await fetch(`${origin}/admin/users`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'http://127.0.0.1',
          'HX-Request': 'true',
        },
        body: 'email=e@x&password=valid-pass-1&role=user',
      })
      expect(res.status).toBe(500)
      expect(res.headers.get('hx-reswap')).toBe('none')
      const body = await res.text()
      expect(body).toContain('hx-swap-oob')
      expect(body).not.toContain('duplicate email') // raw error never leaks to the DOM
    })

    it('an expired session on an htmx request sends HX-Redirect with the DOCUMENT url as next', async () => {
      session.value = null
      const res = await fetch(`${origin}/admin/health/table`, {
        headers: { 'HX-Request': 'true', 'HX-Current-URL': `${origin}/admin?tab=1` },
      })
      expect(res.status).toBe(401)
      // next must be the page (HX-Current-URL), not the fragment url — resuming on
      // /admin/health/table would render a bare <tr> dump after sign-in.
      expect(res.headers.get('hx-redirect')).toBe(`/sign-in?next=${encodeURIComponent('/admin?tab=1')}`)
    })

    it('a non-admin 403 on an htmx request follows the flash contract (no bare <h1> into the target)', async () => {
      session.value = { user: { role: 'user' }, session: {} }
      const res = await fetch(`${origin}/admin/health/table`, { headers: { 'HX-Request': 'true' } })
      expect(res.status).toBe(403)
      expect(res.headers.get('hx-reswap')).toBe('none')
      const body = await res.text()
      expect(body).toContain('hx-swap-oob')
      expect(body).not.toContain('<h1>')
    })

    it('a CSRF 403 on an htmx request follows the flash contract (a rejected DELETE must not eat the row)', async () => {
      session.value = { user: { role: 'admin' }, session: {} }
      const res = await fetch(`${origin}/admin/bases/trade`, {
        method: 'DELETE',
        headers: { origin: 'https://evil.example.com', 'HX-Request': 'true' },
      })
      expect(res.status).toBe(403)
      expect(res.headers.get('hx-reswap')).toBe('none')
      expect(await res.text()).toContain('hx-swap-oob')
    })

    it('an edit request for a vanished base flashes a 404 toast', async () => {
      session.value = { user: { role: 'admin' }, session: {} }
      const res = await fetch(`${origin}/admin/bases/ghost/edit`)
      expect(res.status).toBe(404)
      expect(res.headers.get('hx-reswap')).toBe('none')
      expect(await res.text()).toContain('hx-swap-oob')
    })

    it("an unmatched /admin path 404s via the flash contract for htmx (never Express's default page)", async () => {
      session.value = { user: { role: 'admin' }, session: {} }
      const htmx = await fetch(`${origin}/admin/no/such/route`, { headers: { 'HX-Request': 'true' } })
      expect(htmx.status).toBe(404)
      expect(htmx.headers.get('hx-reswap')).toBe('none')
      expect(await htmx.text()).toContain('hx-swap-oob')
      const page = await fetch(`${origin}/admin/no/such/route`)
      expect(page.status).toBe(404)
      expect(await page.text()).toContain('404')
    })
  })

  describe('error middleware', () => {
    it('a rejecting handler yields a 500, not a crash/hang', async () => {
      session.value = { user: { role: 'admin' }, session: {} }
      createUserApi.mockRejectedValueOnce(new Error('duplicate email'))
      const res = await fetch(`${origin}/admin/users`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1' },
        body: 'email=e@x&password=valid-pass-1&role=user',
      })
      expect(res.status).toBe(500)
      const body = await res.text()
      expect(body).toContain('Internal error')
      expect(body).not.toContain('duplicate email') // raw error never leaks to the DOM
    })
  })
})
