import { BasicAuth, type RequestEvent, TimeoutError } from '@1c-odata/client'
import { HttpResponse, http } from 'msw'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { request } from '../../src/http/transport.js'
import { createMswServer } from '../fixtures/msw-server.js'

const server = createMswServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const base = 'http://1c.test/odata/standard.odata'
const auth = BasicAuth({ username: 'u', password: 'p' })

describe('transport.request', () => {
  it('attaches Authorization + Accept + DataServiceVersion headers', async () => {
    let captured: Record<string, string> = {}
    server.use(
      http.get(`${base}/Catalog_X`, ({ request }) => {
        captured = Object.fromEntries(request.headers.entries())
        return HttpResponse.json({ value: [] })
      }),
    )

    const res = await request(
      {
        method: 'GET',
        url: `${base}/Catalog_X`,
        headers: {
          Authorization: auth.header,
          Accept: 'application/json;odata=nometadata',
          DataServiceVersion: '3.0',
          MaxDataServiceVersion: '3.0',
        },
      },
      {},
    )

    expect(res.status).toBe(200)
    expect(captured.authorization).toBe(auth.header)
    expect(captured['dataserviceversion']).toBe('3.0')
  })

  it('throws TimeoutError when timeout fires', async () => {
    server.use(
      http.get(`${base}/Slow`, async () => {
        await new Promise((r) => setTimeout(r, 200))
        return HttpResponse.json({ value: [] })
      }),
    )

    await expect(
      request({ method: 'GET', url: `${base}/Slow`, headers: { Authorization: auth.header } }, { timeout: 50 }),
    ).rejects.toThrow(TimeoutError)
  })

  it('respects per-call AbortSignal', async () => {
    const ctrl = new AbortController()
    server.use(
      http.get(`${base}/Slow`, async () => {
        await new Promise((r) => setTimeout(r, 200))
        return HttpResponse.json({ value: [] })
      }),
    )

    setTimeout(() => ctrl.abort(), 30)
    await expect(
      request({ method: 'GET', url: `${base}/Slow`, headers: { Authorization: auth.header }, signal: ctrl.signal }, {}),
    ).rejects.toThrowError(/aborted/i)
  })

  it('invokes beforeRequest/afterResponse hooks', async () => {
    server.use(http.get(`${base}/X`, () => HttpResponse.json({ value: [] })))

    const beforeRequest = vi.fn((req: RequestEvent) => req)
    const afterResponse = vi.fn()

    await request(
      { method: 'GET', url: `${base}/X`, headers: { Authorization: auth.header } },
      { hooks: { beforeRequest, afterResponse } },
    )

    expect(beforeRequest).toHaveBeenCalledOnce()
    expect(afterResponse).toHaveBeenCalledOnce()
  })

  it('beforeRequest may modify headers', async () => {
    let captured: Record<string, string> = {}
    server.use(
      http.get(`${base}/X`, ({ request }) => {
        captured = Object.fromEntries(request.headers.entries())
        return HttpResponse.json({ value: [] })
      }),
    )

    await request(
      { method: 'GET', url: `${base}/X`, headers: { Authorization: auth.header } },
      {
        hooks: {
          beforeRequest: (req) => ({ ...req, headers: { ...req.headers, 'x-correlation-id': 'abc-123' } }),
        },
      },
    )

    expect(captured['x-correlation-id']).toBe('abc-123')
  })
})
