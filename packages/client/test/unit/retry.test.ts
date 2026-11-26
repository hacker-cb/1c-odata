import {
  BasicAuth,
  BusinessError,
  HTTPError,
  NetworkError,
  ParseError,
  PermissionError,
  type RetryPolicy,
} from '@1c-odata/client'
import { HttpResponse, http } from 'msw'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { requestWithRetry } from '../../src/http/retry.js'
import { MAX_TIMER_MS } from '../../src/http/timer.js'
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

describe('requestWithRetry — hook errors are never retried, whatever their type (#189)', () => {
  const policy: RetryPolicy = { ...retryPolicy, retryableStatuses: [503], retryableMethods: ['GET', 'PATCH'] }
  const get = { method: 'GET' as const, url: `${base}/Catalog_X`, headers: { Authorization: auth.header } }

  it('a NetworkError thrown from afterResponse (a nested call) is not retried', async () => {
    let n = 0
    server.use(
      http.get(`${base}/Catalog_X`, () => {
        n++
        return HttpResponse.json({ value: [] })
      }),
    )
    const nested = new NetworkError('Network error: fetch failed')
    const err = await requestWithRetry(get, {
      retry: policy,
      hooks: {
        afterResponse: () => {
          throw nested
        },
      },
    }).catch((e: unknown) => e)
    expect(err).toBe(nested)
    expect(n).toBe(1)
  })

  it('onError rethrowing the error it was handed keeps it the library’s: a 503 is still retried', async () => {
    let n = 0
    server.use(
      http.get(`${base}/Catalog_X`, () => {
        n++
        return new HttpResponse('{"odata.error":{"code":"0","message":{"value":"busy"}}}', {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    const err = await requestWithRetry(get, {
      retry: policy,
      hooks: {
        onError: (_req, e) => {
          throw e
        },
      },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HTTPError)
    expect(n).toBe(3)
  })

  it('a caller’s abort with its own reason is rethrown unchanged, not a retried NetworkError', async () => {
    let n = 0
    server.use(
      http.get(`${base}/Catalog_X`, async () => {
        n++
        await new Promise((r) => setTimeout(r, 200))
        return HttpResponse.json({ value: [] })
      }),
    )
    const ctrl = new AbortController()
    const reason = new Error('operation cancelled')
    setTimeout(() => ctrl.abort(reason), 20)
    const onError = vi.fn()
    const err = await requestWithRetry({ ...get, signal: ctrl.signal }, { retry: policy, hooks: { onError } }).catch(
      (e: unknown) => e,
    )
    expect(err).toBe(reason)
    expect(onError).not.toHaveBeenCalled()
    expect(n).toBe(1)
  })
})

describe('requestWithRetry — what stops a retry, re-read (#189)', () => {
  const policy: RetryPolicy = { ...retryPolicy, retryableStatuses: [503], retryableMethods: ['GET'] }
  const get = { method: 'GET' as const, url: `${base}/Catalog_X`, headers: { Authorization: auth.header } }
  const busy = () =>
    new HttpResponse('{"odata.error":{"code":"0","message":{"value":"busy"}}}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })

  it('a primitive thrown by a hook reaches the caller as is and is not retried', async () => {
    let n = 0
    server.use(
      http.get(`${base}/Catalog_X`, () => {
        n++
        return HttpResponse.json({ value: [] })
      }),
    )
    const err = await requestWithRetry(get, {
      retry: policy,
      hooks: {
        afterResponse: () => {
          throw 'audit failed'
        },
      },
    }).catch((e: unknown) => e)
    expect(err).toBe('audit failed')
    expect(n).toBe(1)
  })

  it('a hook thrown from a throwing hooks getter counts as the hook’s and is not retried', async () => {
    let n = 0
    server.use(
      http.get(`${base}/Catalog_X`, () => {
        n++
        return HttpResponse.json({ value: [] })
      }),
    )
    const nested = new NetworkError('Network error: lazy init failed')
    let reads = 0
    const hooks = {
      get afterResponse(): () => void {
        reads++
        throw nested
      },
    }
    const err = await requestWithRetry(get, { retry: policy, hooks }).catch((e: unknown) => e)
    expect(err).toBe(nested)
    expect(reads).toBe(1)
    expect(n).toBe(1)
  })

  it('an abort whose reason is a NetworkError is not retried', async () => {
    let n = 0
    server.use(
      http.get(`${base}/Catalog_X`, async () => {
        n++
        await new Promise((r) => setTimeout(r, 200))
        return HttpResponse.json({ value: [] })
      }),
    )
    const ctrl = new AbortController()
    const reason = new NetworkError('batch cancelled: upstream down')
    setTimeout(() => ctrl.abort(reason), 20)
    const err = await requestWithRetry({ ...get, signal: ctrl.signal }, { retry: policy }).catch((e: unknown) => e)
    expect(err).toBe(reason)
    expect(n).toBe(1)
  })

  it('onError rethrowing the error it was handed is retried even if another request’s hook threw that object meanwhile', async () => {
    let n = 0
    server.use(
      http.get(`${base}/Catalog_X`, () => {
        n++
        return busy()
      }),
      http.get(`${base}/Other`, () => HttpResponse.json({ value: [] })),
    )
    let release = (): void => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let shared: unknown
    let held = (): void => {}
    const holding = new Promise<void>((r) => {
      held = r
    })
    let first = true
    const pending = requestWithRetry(get, {
      retry: policy,
      hooks: {
        onError: async (_req, e) => {
          if (first) {
            first = false
            shared = e
            held()
            await gate
          }
          throw e
        },
      },
    }).catch((e: unknown) => e)
    await holding
    // Meanwhile another request's hook throws that very object, marking it as a hook's …
    await requestWithRetry(
      { ...get, url: `${base}/Other` },
      {
        hooks: {
          afterResponse: () => {
            throw shared
          },
        },
      },
    ).catch(() => {})
    release()
    // … yet the first onError rethrowing it as handed gives it back to the library: retried.
    expect(await pending).toBeInstanceOf(HTTPError)
    expect(n).toBe(3)
  })
})

describe('requestWithRetry — decides by the method actually sent (#189)', () => {
  const busy = () =>
    new HttpResponse('{"odata.error":{"code":"0","message":{"value":"busy"}}}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })
  const policy: RetryPolicy = { ...retryPolicy, retryableStatuses: [503], retryableMethods: ['GET'] }

  it('a beforeRequest turning GET into PATCH: the 503 is not retried when PATCH is not retryable', async () => {
    let n = 0
    server.use(
      http.patch(`${base}/Catalog_X`, () => {
        n++
        return busy()
      }),
    )
    const err = await requestWithRetry(
      { method: 'GET', url: `${base}/Catalog_X`, headers: { Authorization: auth.header } },
      { retry: policy, hooks: { beforeRequest: (req) => ({ ...req, method: 'PATCH', body: '{}' }) } },
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HTTPError)
    expect(n).toBe(1)
  })

  it('a beforeRequest turning PATCH into GET: the 503 is retried when GET is', async () => {
    let n = 0
    server.use(
      http.get(`${base}/Catalog_X`, () => {
        n++
        return busy()
      }),
    )
    await requestWithRetry(
      { method: 'PATCH', url: `${base}/Catalog_X`, headers: { Authorization: auth.header }, body: '{}' },
      {
        retry: policy,
        hooks: {
          beforeRequest: (req) => {
            const { body: _body, ...rest } = req
            return { ...rest, method: 'GET' }
          },
        },
      },
    ).catch(() => {})
    expect(n).toBe(3)
  })
})

describe('requestWithRetry — an outrun onError cannot stop the retry (#212)', () => {
  it('onError rejecting on its aborted signal after the deadline leaves the NetworkError retried', async () => {
    let calls = 0
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls++
      if (calls === 1) throw new TypeError('fetch failed')
      return new Response('{"value":[]}', { status: 200 })
    })
    try {
      const res = await requestWithRetry(
        { method: 'GET', url: `${base}/Catalog_X`, headers: { Authorization: auth.header } },
        {
          timeout: 30,
          retry: retryPolicy,
          hooks: {
            // Rejects with its own error once its signal aborts — past the deadline.
            onError: (req) =>
              new Promise<void>((_, reject) => {
                req.signal?.addEventListener('abort', () => reject(new Error('log write cancelled')), { once: true })
              }),
          },
        },
      )
      expect(res.status).toBe(200)
      expect(calls).toBe(2)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('requestWithRetry — a pause past what a timer keeps (#232)', () => {
  it('a delay above 2³¹−1 ms is capped at it, not fired at once', async () => {
    let n = 0
    server.use(
      http.get(`${base}/Catalog_X`, () => {
        n++
        return new HttpResponse(null, { status: 503 })
      }),
    )
    const spy = vi.spyOn(globalThis, 'setTimeout')
    const caller = new AbortController()
    let pending: Promise<unknown> | undefined
    try {
      pending = requestWithRetry(
        { method: 'GET', url: `${base}/Catalog_X`, headers: { Authorization: auth.header }, signal: caller.signal },
        { retry: { ...retryPolicy, initialDelayMs: 3e9, maxDelayMs: 3e9 } },
      ).catch((e: unknown) => e)
      await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_MS))
      // Fired at once, the pause would have let a second attempt through by now.
      await new Promise((r) => setTimeout(r, 30))
      expect(n).toBe(1)
    } finally {
      // Ends the pause whatever failed above: no 24.8-day timer outlives the test.
      caller.abort()
      spy.mockRestore()
    }
    expect(await pending).toMatchObject({ name: 'AbortError' })
  })
})
