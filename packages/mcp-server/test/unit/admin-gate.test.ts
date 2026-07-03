// test/unit/admin-gate.test.ts
import { createServer } from 'node:http'
import express from 'express'
import { describe, expect, it, vi } from 'vitest'
import type { Auth } from '../../src/auth/better-auth.js'
import { adminGate } from '../../src/http/admin/middleware.js'

function appWith(session: unknown): express.Express {
  const auth = { api: { getSession: vi.fn().mockResolvedValue(session) } } as unknown as Auth
  const app = express()
  app.use(adminGate(auth))
  app.get('/', (_req, res) => {
    res.status(200).send('ok')
  })
  return app
}

async function call(
  app: express.Express,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const srv = createServer(app)
  await new Promise<void>((r) => srv.listen(0, r))
  const addr = srv.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  const res = await fetch(`http://127.0.0.1:${port}/`, { headers, redirect: 'manual' })
  const text = await res.text()
  await new Promise<void>((r) => srv.close(() => r()))
  return { status: res.status, text }
}

describe('adminGate', () => {
  it('403s an authenticated non-admin', async () => {
    const res = await call(appWith({ user: { role: 'user' }, session: {} }), { 'HX-Request': 'true' })
    expect(res.status).toBe(403)
  })

  it('accepts an admin (comma-separated role too)', async () => {
    const res = await call(appWith({ user: { role: 'user,admin' }, session: {} }))
    expect(res.status).toBe(200)
    expect(res.text).toBe('ok')
  })

  it('401s an unauthenticated htmx request', async () => {
    const res = await call(appWith(null), { 'HX-Request': 'true' })
    expect(res.status).toBe(401)
  })

  it('redirects an unauthenticated browser to sign-in', async () => {
    const res = await call(appWith(null))
    expect(res.status).toBe(302)
  })
})
