import { BasicAuth, BusinessError, type RetryPolicy } from '@1c-odata/client'
import { HttpResponse, http } from 'msw'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { requestWithRetry } from '../../src/http/retry.js'
import { createMswServer } from '../fixtures/msw-server.js'

const server = createMswServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const base = 'http://1c.test/odata/standard.odata'
const auth = BasicAuth({ username: 'u', password: 'p' })

const noRetry: RetryPolicy | undefined = undefined
const retryPolicy: RetryPolicy = {
  maxRetries: 2,
  retryableStatuses: [503],
  retryableMethods: ['GET'],
  initialDelayMs: 5,
  maxDelayMs: 20,
  backoffMultiplier: 2,
  jitter: 'none',
}

describe('requestWithRetry', () => {
  it('passes through with no retry policy', async () => {
    const calls = vi.fn(() => HttpResponse.json({ value: [] }))
    server.use(http.get(`${base}/Catalog_X`, calls))
    await requestWithRetry(
      { method: 'GET', url: `${base}/Catalog_X`, headers: { Authorization: auth.header } },
      { retry: noRetry },
    )
    expect(calls).toHaveBeenCalledOnce()
  })

  it('retries on 503 up to maxRetries', async () => {
    let n = 0
    server.use(
      http.get(`${base}/Catalog_X`, () => {
        n++
        if (n < 3)
          return new HttpResponse('{"odata.error":{"code":"0","message":{"value":"busy"}}}', {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
        return HttpResponse.json({ value: [] })
      }),
    )
    await requestWithRetry(
      { method: 'GET', url: `${base}/Catalog_X`, headers: { Authorization: auth.header } },
      { retry: retryPolicy },
    )
    expect(n).toBe(3) // initial + 2 retries
  })

  it('does NOT retry on BusinessError (HTTP 500 + code -1)', async () => {
    let n = 0
    server.use(
      http.get(`${base}/Catalog_X`, () => {
        n++
        return new HttpResponse('{"odata.error":{"code":"-1","message":{"value":"Не удалось провести"}}}', {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    await expect(
      requestWithRetry(
        { method: 'GET', url: `${base}/Catalog_X`, headers: { Authorization: auth.header } },
        { retry: retryPolicy },
      ),
    ).rejects.toThrow(BusinessError)
    expect(n).toBe(1)
  })

  it('does NOT retry methods not in retryableMethods', async () => {
    let n = 0
    server.use(
      http.post(`${base}/Catalog_X`, () => {
        n++
        return new HttpResponse('', { status: 503, headers: { 'content-type': 'application/json' } })
      }),
    )
    await expect(
      requestWithRetry(
        { method: 'POST', url: `${base}/Catalog_X`, headers: { Authorization: auth.header } },
        { retry: retryPolicy },
      ),
    ).rejects.toThrow()
    expect(n).toBe(1)
  })
})
