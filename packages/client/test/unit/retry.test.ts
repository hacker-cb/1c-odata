import { BasicAuth, BusinessError, NetworkError, ParseError, PermissionError, type RetryPolicy } from '@1c-odata/client'
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
    await requestWithRetry({ method: 'GET', url: `${base}/Catalog_X`, headers: { Authorization: auth.header } }, {})
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

describe('requestWithRetry — only wire failures are network errors (#189)', () => {
  const writePolicy: RetryPolicy = {
    ...retryPolicy,
    retryableStatuses: [500, 503],
    retryableMethods: ['GET', 'PATCH'],
  }
  const patch = {
    method: 'PATCH' as const,
    url: `${base}/Catalog_X`,
    headers: { Authorization: auth.header },
    body: '{}',
  }
  const odataError = (status: number, code: string) =>
    new HttpResponse(`{"odata.error":{"code":"${code}","message":{"value":"x"}}}`, {
      status,
      headers: { 'content-type': 'application/json' },
    })

  it('a throwing afterResponse reaches the caller as is, onError untouched, the write sent once', async () => {
    let n = 0
    server.use(
      http.patch(`${base}/Catalog_X`, () => {
        n++
        return HttpResponse.json({})
      }),
    )
    const hookErr = new Error('audit log down')
    const onError = vi.fn()
    const err = await requestWithRetry(patch, {
      retry: writePolicy,
      hooks: {
        afterResponse: () => {
          throw hookErr
        },
        onError,
      },
    }).catch((e: unknown) => e)
    expect(err).toBe(hookErr)
    expect(onError).not.toHaveBeenCalled()
    expect(n).toBe(1)
  })

  it('an onError throwing on a 401 (re-login) reaches the caller as is, called once, the write sent once', async () => {
    let n = 0
    server.use(
      http.patch(`${base}/Catalog_X`, () => {
        n++
        return odataError(401, '20')
      }),
    )
    const relogin = new Error('re-login required')
    const onError = vi.fn((_req: unknown, _err: unknown): void => {
      throw relogin
    })
    const err = await requestWithRetry(patch, { retry: writePolicy, hooks: { onError } }).catch((e: unknown) => e)
    expect(err).toBe(relogin)
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0]?.[1]).toBeInstanceOf(PermissionError)
    expect(n).toBe(1)
  })

  it('an onError throwing on a retryable 500 is not retried either', async () => {
    let n = 0
    server.use(
      http.patch(`${base}/Catalog_X`, () => {
        n++
        return odataError(500, '0')
      }),
    )
    const hookErr = new Error('metrics down')
    const onError = vi.fn((): void => {
      throw hookErr
    })
    const err = await requestWithRetry(patch, { retry: writePolicy, hooks: { onError } }).catch((e: unknown) => e)
    expect(err).toBe(hookErr)
    expect(onError).toHaveBeenCalledOnce()
    expect(n).toBe(1)
  })

  it('a JSON error body of null is a ParseError, not a retried NetworkError', async () => {
    let n = 0
    server.use(
      http.patch(`${base}/Catalog_X`, () => {
        n++
        return new HttpResponse('null', { status: 500, headers: { 'content-type': 'application/json' } })
      }),
    )
    const err = await requestWithRetry(patch, { retry: writePolicy }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ParseError)
    expect(err).not.toBeInstanceOf(NetworkError)
    expect(n).toBe(1)
  })

  it('a failed fetch is still a NetworkError, and still retried', async () => {
    let n = 0
    server.use(
      http.patch(`${base}/Catalog_X`, () => {
        n++
        return HttpResponse.error()
      }),
    )
    const err = await requestWithRetry(patch, { retry: writePolicy }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NetworkError)
    expect(n).toBe(3)
  })
})
