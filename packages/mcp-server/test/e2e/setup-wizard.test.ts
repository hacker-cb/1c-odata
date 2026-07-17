// test/e2e/setup-wizard.test.ts
//
// Drives the first-run wizard over real HTTP against a REAL better-auth instance
// (so createUser actually seeds the admin and countAdmins() reflects it):
//   - no admin + valid token → GET renders the form; POST creates the admin, 302s
//     to /sign-in, and burns the token;
//   - wrong / missing token → 404 (no page, no oracle);
//   - a same-origin CSRF failure on POST → 403;
//   - once an admin exists → GET/POST are 404 forever.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildAuth } from '../../src/auth/better-auth.js'
import { resolveCanonicalUrls } from '../../src/auth/config.js'
import { createSetupRouter } from '../../src/http/setup/router.js'
import { createDb, type DbHandle } from '../../src/store/db.js'
import { runAuthMigrations } from '../../src/store/migrate.js'
import { countAdmins, SetupTokenRepo } from '../../src/store/repos.js'

const SECRET = 'e2e-secret-not-for-prod-0123456789'
const TOKEN = 'valid-setup-token-abc123'

let handle: DbHandle
let server: Server
let origin: string
// biome-ignore lint/suspicious/noExplicitAny: the inferred betterAuth() type is not portable; structural use only.
let auth: any

beforeEach(async () => {
  handle = createDb({ kind: 'pglite' })
  await runAuthMigrations(handle)
  await new SetupTokenRepo(handle.db).ensure(TOKEN)
  // publicUrl is used ONLY for the same-origin CSRF check; it need not be the
  // socket origin here, so pin a stable value the tests send as Origin.
  const publicUrl = 'http://127.0.0.1'
  auth = buildAuth({ urls: resolveCanonicalUrls(publicUrl), db: handle.db, secret: SECRET })

  const app = express()
  app.use(express.json())
  app.use('/setup', createSetupRouter({ auth, db: handle.db, publicUrl }))
  server = createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await handle.close()
})

describe('first-run setup wizard', () => {
  it('GET with a valid token renders the wizard form', async () => {
    const res = await fetch(`${origin}/setup?token=${TOKEN}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('First-run setup')
    expect(html).toContain('name="email"')
    expect(html).toContain('name="password"')
    // The token is carried back in a hidden field so the POST re-presents it.
    expect(html).toContain(`value="${TOKEN}"`)
  })

  it('GET with a WRONG token → 404', async () => {
    const res = await fetch(`${origin}/setup?token=nope`)
    expect(res.status).toBe(404)
  })

  it('GET with a MISSING token → 404', async () => {
    const res = await fetch(`${origin}/setup`)
    expect(res.status).toBe(404)
  })

  it('POST with valid token + same-origin + fields creates the admin, 302s, burns the token', async () => {
    const res = await fetch(`${origin}/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1' },
      body: new URLSearchParams({
        token: TOKEN,
        email: 'admin@example.com',
        password: 'Password123!',
        confirm: 'Password123!',
      }).toString(),
      redirect: 'manual',
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/sign-in')
    // The admin now exists, and the single-use token is gone.
    expect(await countAdmins(handle.db)).toBe(1)
    expect(await new SetupTokenRepo(handle.db).get()).toBeNull()
  })

  it('POST with a cross-origin Origin → 403 (CSRF), no admin created', async () => {
    const res = await fetch(`${origin}/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example.com' },
      body: new URLSearchParams({ token: TOKEN, email: 'x@example.com', password: 'Password123!' }).toString(),
      redirect: 'manual',
    })
    expect(res.status).toBe(403)
    expect(await countAdmins(handle.db)).toBe(0)
  })

  it('POST with a missing password → re-renders the form (no redirect), no admin created', async () => {
    const res = await fetch(`${origin}/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1' },
      body: new URLSearchParams({ token: TOKEN, email: 'x@example.com' }).toString(),
      redirect: 'manual',
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Email and password are required')
    expect(await countAdmins(handle.db)).toBe(0)
  })

  it('POST with mismatched confirm → re-renders with an error, no admin created', async () => {
    const res = await fetch(`${origin}/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1' },
      body: new URLSearchParams({
        token: TOKEN,
        email: 'x@example.com',
        password: 'Password123!',
        confirm: 'Different1!',
      }).toString(),
      redirect: 'manual',
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Passwords do not match')
    expect(await countAdmins(handle.db)).toBe(0)
  })

  it('once an admin exists, GET with the (now-cleared) token → 404 forever', async () => {
    // Seed an admin the direct way, then the wizard must be closed even if a token
    // somehow lingered.
    await auth.api.createUser({
      body: { email: 'root@example.com', password: 'Password123!', name: 'Admin', role: 'admin' },
    })
    await new SetupTokenRepo(handle.db).ensure(TOKEN) // pretend a token is still present
    const res = await fetch(`${origin}/setup?token=${TOKEN}`)
    expect(res.status).toBe(404)
    // And a POST is likewise closed.
    const post = await fetch(`${origin}/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://127.0.0.1' },
      body: new URLSearchParams({ token: TOKEN, email: 'x@example.com', password: 'Password123!' }).toString(),
      redirect: 'manual',
    })
    expect(post.status).toBe(404)
  })
})
