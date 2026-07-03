// test/unit/admin-csrf.test.ts
import { createServer } from 'node:http'
import express from 'express'
import { describe, expect, it } from 'vitest'
import { adminCsrf } from '../../src/http/admin/middleware.js'

function appWith(publicUrl: string): express.Express {
  const app = express()
  app.use(adminCsrf(publicUrl))
  app.all('/x', (_req, res) => {
    res.status(200).send('ok')
  })
  return app
}

async function call(
  app: express.Express,
  method: string,
  headers: Record<string, string> = {},
): Promise<{ status: number }> {
  const srv = createServer(app)
  await new Promise<void>((r) => srv.listen(0, r))
  const addr = srv.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  const res = await fetch(`http://127.0.0.1:${port}/x`, { method, headers })
  await new Promise<void>((r) => srv.close(() => r()))
  return { status: res.status }
}

describe('adminCsrf', () => {
  const app = appWith('http://127.0.0.1:3000')

  it('allows safe methods regardless of Origin', async () => {
    expect((await call(app, 'GET', { origin: 'https://evil.example.com' })).status).toBe(200)
  })

  it('allows an unsafe method with a matching Origin', async () => {
    expect((await call(app, 'POST', { origin: 'http://127.0.0.1:3000' })).status).toBe(200)
  })

  it('falls back to Referer when Origin is absent', async () => {
    expect((await call(app, 'POST', { referer: 'http://127.0.0.1:3000/admin/bases' })).status).toBe(200)
  })

  it('rejects a cross-origin unsafe method (wrong Origin) with 403', async () => {
    expect((await call(app, 'POST', { origin: 'https://evil.example.com' })).status).toBe(403)
  })

  it('rejects an unsafe method with neither Origin nor Referer', async () => {
    expect((await call(app, 'DELETE')).status).toBe(403)
  })

  it('fails closed on a malformed publicUrl (rejects every unsafe write)', async () => {
    const bad = appWith('not a url')
    expect((await call(bad, 'POST', { origin: 'not a url' })).status).toBe(403)
  })
})
