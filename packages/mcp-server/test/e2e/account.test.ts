// test/e2e/account.test.ts
//
// Drives the /account router over real HTTP: the any-role session gate, the
// change-password flow (flash contract both ways), sign-out cookie forwarding,
// and the CSRF guard. better-auth is stubbed — the wiring is under test.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auth } from '../../src/auth/better-auth.js'
import { createAccountRouter } from '../../src/http/account/router.js'

let server: Server
let origin: string
const session = { value: null as unknown }
// revokeOtherSessions rotates the current session → better-auth returns a fresh
// Set-Cookie the handler must forward. Model that with returnHeaders.
const changePassword = vi.fn(async (_arg?: unknown) => {
  const headers = new Headers()
  headers.append('set-cookie', 'better-auth.session_token=rotated; Path=/; HttpOnly')
  return { headers, response: {} }
})
const signOut = vi.fn(async (_arg?: unknown) => {
  const headers = new Headers()
  headers.append('set-cookie', 'better-auth.session_token=; Max-Age=0; Path=/')
  return { headers, response: { success: true } }
})

beforeEach(async () => {
  changePassword.mockClear()
  signOut.mockClear()
  const auth = {
    api: {
      getSession: vi.fn().mockImplementation(async () => session.value),
      changePassword,
      signOut,
    },
  } as unknown as Auth
  const app = express()
  app.use('/account', createAccountRouter({ auth, publicUrl: 'http://127.0.0.1' }))
  server = createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

describe('/account over HTTP', () => {
  it('redirects an anonymous browser to sign-in with next=/account', async () => {
    session.value = null
    const res = await fetch(`${origin}/account`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/sign-in?next=%2Faccount')
  })

  it('renders the page for a PLAIN user: email chip + change-password form, NO admin nav sections', async () => {
    session.value = { user: { id: 'u1', email: 'user@x.dev', role: 'user' }, session: {} }
    const res = await fetch(`${origin}/account`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Change password')
    expect(html).toContain('user@x.dev')
    expect(html).toContain('data-gen-password') // generator + copy affordances present
    expect(html).toContain('action="/account/sign-out"')
    expect(html).not.toContain('href="/admin/bases"') // admin sections hidden for a plain user
  })

  it('keeps the full admin nav for an admin visiting /account', async () => {
    session.value = { user: { id: 'a1', email: 'admin@x.dev', role: 'admin' }, session: {} }
    const html = await (await fetch(`${origin}/account`)).text()
    expect(html).toContain('href="/admin/bases"')
  })

  it('changes the password with revokeOtherSessions and flashes ok', async () => {
    session.value = { user: { id: 'u1', email: 'user@x.dev', role: 'user' }, session: {} }
    const res = await fetch(`${origin}/account/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1' },
      body: 'current=old-pass-1&password=new-pass-123',
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('flash-msg ok')
    expect(changePassword).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { currentPassword: 'old-pass-1', newPassword: 'new-pass-123', revokeOtherSessions: true },
        returnHeaders: true,
      }),
    )
    // The rotated session cookie must be forwarded, or the browser keeps the dead
    // token and is bounced to sign-in on its next request.
    expect(res.headers.get('set-cookie')).toContain('rotated')
  })

  it('a wrong current password flashes a redacted 400', async () => {
    session.value = { user: { id: 'u1', email: 'user@x.dev', role: 'user' }, session: {} }
    changePassword.mockRejectedValueOnce(new Error('INVALID_PASSWORD: nope'))
    const res = await fetch(`${origin}/account/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1' },
      body: 'current=wrong&password=new-pass-123',
    })
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).toContain('hx-swap-oob')
    expect(body).not.toContain('INVALID_PASSWORD') // raw plugin error never leaks
  })

  it('sign-out forwards the cookie-clearing headers and lands on sign-in', async () => {
    session.value = { user: { id: 'u1', email: 'user@x.dev', role: 'user' }, session: {} }
    const res = await fetch(`${origin}/account/sign-out`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1' },
      redirect: 'manual',
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/sign-in')
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('sign-out without a session still lands on sign-in (no 500)', async () => {
    session.value = null
    signOut.mockRejectedValueOnce(new Error('no session'))
    const res = await fetch(`${origin}/account/sign-out`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1' },
      redirect: 'manual',
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/sign-in')
  })

  it('rejects a cross-origin password POST (CSRF) before the handler', async () => {
    session.value = { user: { id: 'u1', email: 'user@x.dev', role: 'user' }, session: {} }
    const res = await fetch(`${origin}/account/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example.com' },
      body: 'current=a&password=new-pass-123',
    })
    expect(res.status).toBe(403)
    expect(changePassword).not.toHaveBeenCalled()
  })
})
