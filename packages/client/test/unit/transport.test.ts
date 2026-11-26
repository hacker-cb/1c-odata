import { BasicAuth, HTTPError, NetworkError, type RequestEvent, TimeoutError } from '@1c-odata/client'
import { HttpResponse, http } from 'msw'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { type AttemptTrace, request, requestStream } from '../../src/http/transport.js'
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

  it('throws TimeoutError (carrying request context) when timeout fires', async () => {
    server.use(
      http.get(`${base}/Slow`, async () => {
        await new Promise((r) => setTimeout(r, 200))
        return HttpResponse.json({ value: [] })
      }),
    )

    const err = await request(
      { method: 'GET', url: `${base}/Slow`, headers: { Authorization: auth.header } },
      { timeout: 50 },
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TimeoutError)
    expect((err as TimeoutError).request).toEqual({ method: 'GET', url: `${base}/Slow` })
  })

  it('thrown HTTPError carries request context (method + url)', async () => {
    server.use(
      http.get(`${base}/Missing`, () =>
        HttpResponse.json(
          { 'odata.error': { code: '9', message: { lang: 'ru', value: 'не найдено' } } },
          { status: 404 },
        ),
      ),
    )

    const err = await request(
      { method: 'GET', url: `${base}/Missing`, headers: { Authorization: auth.header } },
      {},
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HTTPError)
    expect((err as HTTPError).status).toBe(404)
    expect((err as HTTPError).request).toEqual({ method: 'GET', url: `${base}/Missing` })
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

describe('transport.request — NetworkError carries the undici cause (#180)', () => {
  /** An undici-shaped rejection: `TypeError('fetch failed')` with the real reason in `cause`. */
  function fetchFailed(cause?: unknown): TypeError {
    return new TypeError('fetch failed', cause === undefined ? undefined : { cause })
  }
  function withCode(message: string, code: string): Error {
    return Object.assign(new Error(message), { code })
  }

  async function networkErrorFor(rejection: unknown): Promise<NetworkError> {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(rejection)
    try {
      const err = await request({ method: 'GET', url: `${base}/X`, headers: {} }, {}).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(NetworkError)
      return err as NetworkError
    } finally {
      spy.mockRestore()
    }
  }

  it('appends the TLS code + text and a trust hint for a certificate-chain failure', async () => {
    const cause = withCode('unable to get local issuer certificate', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY')
    const err = await networkErrorFor(fetchFailed(cause))
    expect(err.message).toBe(
      'Network error: fetch failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY: unable to get local issuer certificate); ' +
        'the server certificate is not trusted by Node — add the issuing CA with NODE_EXTRA_CA_CERTS=/path/to/ca.pem, ' +
        'or trust the OS certificate store with NODE_USE_SYSTEM_CA=1 (README "Network configuration")',
    )
    // The original error stays reachable for programmatic inspection.
    expect((err.cause as TypeError).cause).toBe(cause)
  })

  it('appends a DNS failure without a TLS hint', async () => {
    const err = await networkErrorFor(fetchFailed(withCode('getaddrinfo ENOTFOUND 1c.example', 'ENOTFOUND')))
    expect(err.message).toBe('Network error: fetch failed (getaddrinfo ENOTFOUND 1c.example)')
  })

  it('reads the per-address errors of an AggregateError whose own message is empty', async () => {
    const agg = Object.assign(
      new AggregateError(
        [
          withCode('connect ECONNREFUSED ::1:8080', 'ECONNREFUSED'),
          withCode('connect ECONNREFUSED 127.0.0.1:8080', 'ECONNREFUSED'),
        ],
        '',
      ),
      { code: 'ECONNREFUSED' },
    )
    const err = await networkErrorFor(fetchFailed(agg))
    expect(err.message).toBe(
      'Network error: fetch failed (connect ECONNREFUSED ::1:8080; connect ECONNREFUSED 127.0.0.1:8080)',
    )
  })

  it('falls back to the cause text when it has no code', async () => {
    const err = await networkErrorFor(fetchFailed(new Error('bad port')))
    expect(err.message).toBe('Network error: fetch failed (bad port)')
  })

  it('follows a nested cause — a proxy TLS failure names the certificate error under it', async () => {
    const tls = withCode('unable to get local issuer certificate', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY')
    const proxy = Object.assign(new Error('Secure Proxy Connection failed', { cause: tls }), {
      code: 'UND_ERR_PRX_TLS',
    })
    const err = await networkErrorFor(fetchFailed(proxy))
    expect(err.message).toMatch(
      /^Network error: fetch failed \(UND_ERR_PRX_TLS: Secure Proxy Connection failed; UNABLE_TO_GET_ISSUER_CERT_LOCALLY: unable to get local issuer certificate\); the server certificate is not trusted by Node/,
    )
  })

  it('keeps the trust hint when the outer message already repeats the cause', async () => {
    const cause = withCode('self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT')
    const err = await networkErrorFor(new Error('DEPTH_ZERO_SELF_SIGNED_CERT: self-signed certificate', { cause }))
    expect(err.message).toMatch(/^Network error: DEPTH_ZERO_SELF_SIGNED_CERT: self-signed certificate; the server/)
  })

  it('reads an AggregateError thrown directly, with no cause', async () => {
    const agg = new AggregateError([withCode('connect ETIMEDOUT 10.0.0.1:80', 'ETIMEDOUT')], '')
    expect((await networkErrorFor(agg)).message).toBe('Network error: unknown (connect ETIMEDOUT 10.0.0.1:80)')
  })

  it('keeps a code that the sub-error message does not name', async () => {
    const agg = new AggregateError(
      [withCode('connect failed', 'ECONNREFUSED'), withCode('connect failed', 'ETIMEDOUT')],
      '',
    )
    expect((await networkErrorFor(fetchFailed(agg))).message).toBe(
      'Network error: fetch failed (ECONNREFUSED: connect failed; ETIMEDOUT: connect failed)',
    )
  })

  it('follows the cause of each AggregateError attempt', async () => {
    const tls = withCode('self-signed certificate in certificate chain', 'SELF_SIGNED_CERT_IN_CHAIN')
    const attempt = Object.assign(new Error('Secure Proxy Connection failed', { cause: tls }), {
      code: 'UND_ERR_PRX_TLS',
    })
    const err = await networkErrorFor(fetchFailed(new AggregateError([attempt], '')))
    expect(err.message).toMatch(/SELF_SIGNED_CERT_IN_CHAIN: self-signed certificate in certificate chain\); the server/)
  })

  it('shows the code of an AggregateError thrown directly when nothing else names it', async () => {
    const agg = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' })
    expect((await networkErrorFor(agg)).message).toBe('Network error: unknown (ECONNREFUSED)')
  })

  it('does not repeat the code of the caught error when its message names it', async () => {
    const err = await networkErrorFor(withCode('read ECONNRESET', 'ECONNRESET'))
    expect(err.message).toBe('Network error: read ECONNRESET')
  })

  it('keeps attempts whose texts are prefixes of each other', async () => {
    const agg = new AggregateError(
      [
        withCode('connect ECONNREFUSED 10.0.0.1:80', 'ECONNREFUSED'),
        withCode('connect ECONNREFUSED 10.0.0.1:8080', 'ECONNREFUSED'),
      ],
      '',
    )
    expect((await networkErrorFor(fetchFailed(agg))).message).toBe(
      'Network error: fetch failed (connect ECONNREFUSED 10.0.0.1:80; connect ECONNREFUSED 10.0.0.1:8080)',
    )
  })

  it('still yields a NetworkError when inspecting the cause throws', async () => {
    const hostile = new Error('fetch failed')
    Object.defineProperty(hostile, 'cause', {
      get() {
        throw new Error('boom')
      },
    })
    const err = await networkErrorFor(hostile)
    expect(err.message).toBe('Network error: fetch failed')
    expect(err.cause).toBe(hostile)
  })

  it('keeps the bare message when there is no cause, or it adds nothing', async () => {
    expect((await networkErrorFor(fetchFailed())).message).toBe('Network error: fetch failed')
    expect((await networkErrorFor(new Error('socket hang up', { cause: new Error('socket hang up') }))).message).toBe(
      'Network error: socket hang up',
    )
    expect((await networkErrorFor(fetchFailed({ unrelated: true }))).message).toBe('Network error: fetch failed')
    // A short cause text that merely occurs inside the outer message is still shown.
    expect((await networkErrorFor(fetchFailed(new Error('failed')))).message).toBe(
      'Network error: fetch failed (failed)',
    )
  })
})

describe('transport — timeout around beforeRequest (#190)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const target = { method: 'GET' as const, url: `${base}/X`, headers: { Authorization: auth.header } }

  for (const [name, call] of [
    ['request', request],
    ['requestStream', requestStream],
  ] as const) {
    it(`${name}: a rejecting hook fails the call with its own error, leaving no timer and its signal aborted`, async () => {
      vi.useFakeTimers()
      const hookErr = new Error('token fetch failed')
      let hookSignal: AbortSignal | undefined
      const onError = vi.fn()
      const err = await call(target, {
        timeout: 60_000,
        hooks: {
          beforeRequest: async (req) => {
            hookSignal = req.signal
            throw hookErr
          },
          onError,
        },
      }).catch((e: unknown) => e)
      expect(err).toBe(hookErr)
      expect(onError).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      // The call is over: work the hook left running under its signal is cancelled.
      expect(hookSignal?.aborted).toBe(true)
    })

    it(`${name}: a hook still pending at the deadline fails the call with TimeoutError, even ignoring the signal`, async () => {
      const onError = vi.fn()
      const err = await call(target, {
        timeout: 30,
        hooks: { beforeRequest: () => new Promise<void>(() => {}), onError },
      }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(TimeoutError)
      expect((err as TimeoutError).timeoutMs).toBe(30)
      expect(onError).toHaveBeenCalledOnce()
      expect(onError.mock.calls[0]?.[1]).toBe(err)
    })

    it(`${name}: a hook aborted by the deadline through its signal yields TimeoutError, not a bare AbortError`, async () => {
      const err = await call(target, {
        timeout: 30,
        hooks: {
          beforeRequest: (req) =>
            new Promise<void>((_, reject) => {
              req.signal?.addEventListener('abort', () => reject(req.signal?.reason), { once: true })
            }),
        },
      }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(TimeoutError)
    })

    it(`${name}: a caller's abort during the hook stays the caller's abort, not a timeout`, async () => {
      const ctrl = new AbortController()
      const onError = vi.fn()
      setTimeout(() => ctrl.abort(), 10)
      const err = await call(target, {
        timeout: 5_000,
        signal: ctrl.signal,
        hooks: { beforeRequest: () => new Promise<void>(() => {}), onError },
      }).catch((e: unknown) => e)
      expect(err).not.toBeInstanceOf(TimeoutError)
      expect((err as Error).name).toBe('AbortError')
      expect(onError).not.toHaveBeenCalled()
    })
  }

  it('calls beforeRequest as a method of the hooks object, synchronously', async () => {
    server.use(http.get(`${base}/X`, () => HttpResponse.json({ value: [] })))
    let ran = false
    const hooks = {
      token: 'abc',
      beforeRequest(this: { token: string }, req: RequestEvent): RequestEvent {
        ran = true
        return { ...req, headers: { ...req.headers, 'x-token': this.token } }
      },
    }
    const pending = request(target, { timeout: 60_000, hooks })
    expect(ran).toBe(true)
    await expect(pending).resolves.toMatchObject({ status: 200 })
  })
})

describe('requestStream — a throwing afterResponse releases the response (#189)', () => {
  it('cancels the unread body and rethrows the hook’s error as is', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream({ cancel })
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }))
    try {
      const hookErr = new Error('metrics down')
      const err = await requestStream(
        { method: 'GET', url: `${base}/File`, headers: {} },
        {
          hooks: {
            afterResponse: () => {
              throw hookErr
            },
          },
        },
      ).catch((e: unknown) => e)
      expect(err).toBe(hookErr)
      expect(cancel).toHaveBeenCalledOnce()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('transport — a caller’s abort beats a later timeout (#189)', () => {
  it('a caller abort before the timer fires stays the caller’s abort', async () => {
    server.use(
      http.get(`${base}/Slow`, async () => {
        await new Promise((r) => setTimeout(r, 300))
        return HttpResponse.json({ value: [] })
      }),
    )
    const ctrl = new AbortController()
    const reason = new Error('caller gave up')
    const onError = vi.fn()
    // The caller aborts at 20 ms; the timer would fire at 40 ms — both before fetch settles here.
    setTimeout(() => ctrl.abort(reason), 20)
    const err = await request(
      { method: 'GET', url: `${base}/Slow`, headers: {}, signal: ctrl.signal },
      {
        timeout: 40,
        hooks: {
          beforeRequest: () => new Promise<void>((r) => setTimeout(r, 60)),
          onError,
        },
      },
    ).catch((e: unknown) => e)
    expect(err).toBe(reason)
    expect(err).not.toBeInstanceOf(TimeoutError)
    expect(onError).not.toHaveBeenCalled()
  })
})

describe('transport — the per-call hook trace retry reads (#189)', () => {
  const at = (path: string) => ({ method: 'GET' as const, url: `${base}/${path}`, headers: {} })
  const failing = () =>
    new HttpResponse('{"odata.error":{"code":"0","message":{"value":"busy"}}}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })

  it('records a hook’s own exception, not onError rethrowing what it was handed', async () => {
    server.use(
      http.get(`${base}/Ok`, () => HttpResponse.json({ value: [] })),
      http.get(`${base}/Busy`, failing),
    )
    const afterTrace: AttemptTrace = { threw: false }
    await request(at('Ok'), { hooks: { afterResponse: () => Promise.reject(new Error('x')) } }, afterTrace).catch(
      () => {},
    )
    expect(afterTrace.threw).toBe(true)

    const rethrowTrace: AttemptTrace = { threw: false }
    const rethrown = await request(
      at('Busy'),
      {
        hooks: {
          onError: (_req, e) => {
            throw e
          },
        },
      },
      rethrowTrace,
    ).catch((e: unknown) => e)
    expect(rethrown).toBeInstanceOf(HTTPError)
    expect(rethrowTrace.threw).toBe(false)

    const otherTrace: AttemptTrace = { threw: false }
    await request(
      at('Busy'),
      {
        hooks: {
          onError: () => {
            throw new Error('re-login')
          },
        },
      },
      otherTrace,
    ).catch(() => {})
    expect(otherTrace.threw).toBe(true)
  })

  it('keeps two concurrent calls apart when their hooks throw the same error object', async () => {
    server.use(
      http.get(`${base}/Ok`, () => HttpResponse.json({ value: [] })),
      http.get(`${base}/Busy`, failing),
    )
    let release = (): void => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let handed: unknown
    let held = (): void => {}
    const holding = new Promise<void>((r) => {
      held = r
    })
    // B: onError holds the error it was handed, then rethrows it — the library's error.
    const bTrace: AttemptTrace = { threw: false }
    const b = request(
      at('Busy'),
      {
        hooks: {
          onError: async (_req, e) => {
            handed = e
            held()
            await gate
            throw e
          },
        },
      },
      bTrace,
    ).catch((e: unknown) => e)
    await holding
    // A: its afterResponse throws that same object — A's hook's own exception.
    const aTrace: AttemptTrace = { threw: false }
    const a = request(
      at('Ok'),
      {
        hooks: {
          afterResponse: async () => {
            release()
            await b
            throw handed
          },
        },
      },
      aTrace,
    ).catch((e: unknown) => e)
    expect(await a).toBe(handed)
    expect(await b).toBe(handed)
    expect(aTrace.threw).toBe(true)
    expect(bTrace.threw).toBe(false)
  })
})

describe('transport — beforeRequest under a request signal, merged (#189 over #190)', () => {
  it('a caller abort during the hook leaves no timer behind', async () => {
    vi.useFakeTimers()
    try {
      const ctrl = new AbortController()
      const reason = new Error('caller gave up')
      const pending = request(
        { method: 'GET', url: `${base}/X`, headers: {}, signal: ctrl.signal },
        { timeout: 60_000, hooks: { beforeRequest: () => new Promise<void>(() => {}) } },
      ).catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(10)
      ctrl.abort(reason)
      expect(await pending).toBe(reason)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a hook that failed first keeps its own error even if the caller aborts right after', async () => {
    const ctrl = new AbortController()
    const hookErr = new Error('token refresh failed')
    const err = await request(
      { method: 'GET', url: `${base}/X`, headers: {}, signal: ctrl.signal },
      {
        timeout: 60_000,
        hooks: {
          beforeRequest: () => {
            queueMicrotask(() => ctrl.abort(new Error('late abort')))
            throw hookErr
          },
        },
      },
    ).catch((e: unknown) => e)
    expect(err).toBe(hookErr)
  })
})

describe('requestStream — timeout around afterResponse (#204)', () => {
  const target = { method: 'GET' as const, url: `${base}/X`, headers: { Authorization: auth.header } }

  /** A 200 whose unread body records its cancellation. */
  function streamed() {
    const cancel = vi.fn()
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(new ReadableStream({ cancel }), { status: 200 }))
    return { cancel, restore: () => spy.mockRestore() }
  }

  it('a hook still pending at the deadline fails the call with TimeoutError, even ignoring the signal; the body is cancelled', async () => {
    const { cancel, restore } = streamed()
    try {
      const afterResponse = vi.fn(() => new Promise<void>(() => {}))
      const onError = vi.fn()
      const err = await requestStream(target, { timeout: 30, hooks: { afterResponse, onError } }).catch(
        (e: unknown) => e,
      )
      expect(afterResponse).toHaveBeenCalledOnce()
      expect(err).toBeInstanceOf(TimeoutError)
      expect((err as TimeoutError).timeoutMs).toBe(30)
      expect(onError).toHaveBeenCalledOnce()
      expect(onError.mock.calls[0]?.[1]).toBe(err)
      expect(cancel).toHaveBeenCalledOnce()
    } finally {
      restore()
    }
  })

  it('a hook aborted by the deadline through its signal yields TimeoutError, not a bare AbortError', async () => {
    const { restore } = streamed()
    try {
      const afterResponse = vi.fn(
        (req: RequestEvent) =>
          new Promise<void>((_, reject) => {
            req.signal?.addEventListener('abort', () => reject(req.signal?.reason), { once: true })
          }),
      )
      const err = await requestStream(target, { timeout: 30, hooks: { afterResponse } }).catch((e: unknown) => e)
      expect(afterResponse).toHaveBeenCalledOnce()
      expect(err).toBeInstanceOf(TimeoutError)
    } finally {
      restore()
    }
  })

  it('a hook stopping the abort event on req.signal still cannot hold the call past the deadline', async () => {
    const { restore } = streamed()
    try {
      const afterResponse = (req: RequestEvent) => {
        req.signal?.addEventListener('abort', (ev) => ev.stopImmediatePropagation())
        return new Promise<void>(() => {})
      }
      const err = await requestStream(target, { timeout: 30, hooks: { afterResponse } }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(TimeoutError)
    } finally {
      restore()
    }
  })

  it("a caller's abort during the hook stays the caller's abort, not a timeout", async () => {
    const { cancel, restore } = streamed()
    try {
      const ctrl = new AbortController()
      const reason = new Error('caller gave up')
      const onError = vi.fn()
      const afterResponse = () => {
        setTimeout(() => ctrl.abort(reason), 10)
        return new Promise<void>(() => {})
      }
      const err = await requestStream(target, {
        timeout: 5_000,
        signal: ctrl.signal,
        hooks: { afterResponse, onError },
      }).catch((e: unknown) => e)
      expect(err).toBe(reason)
      expect(onError).not.toHaveBeenCalled()
      expect(cancel).toHaveBeenCalledOnce()
    } finally {
      restore()
    }
  })

  it('a hook that throws its own error ends the call with it, and aborts what it left under req.signal', async () => {
    const { restore } = streamed()
    try {
      const hookErr = new Error('metrics down')
      let hookSignal: AbortSignal | undefined
      const err = await requestStream(target, {
        timeout: 60_000,
        hooks: {
          afterResponse: (req) => {
            hookSignal = req.signal
            throw hookErr
          },
        },
      }).catch((e: unknown) => e)
      expect(err).toBe(hookErr)
      expect(hookSignal?.aborted).toBe(true)
    } finally {
      restore()
    }
  })

  it('a throwing hooks getter still releases the body', async () => {
    const { cancel, restore } = streamed()
    try {
      const getterErr = new Error('hooks getter')
      let reads = 0
      const opts = {
        timeout: 60_000,
        get hooks() {
          reads++
          if (reads > 1) throw getterErr
          return {}
        },
      }
      const err = await requestStream(target, opts).catch((e: unknown) => e)
      expect(err).toBe(getterErr)
      expect(cancel).toHaveBeenCalledOnce()
    } finally {
      restore()
    }
  })

  it('a hook that settles in time leaves the call as it was', async () => {
    const { restore } = streamed()
    try {
      const res = await requestStream(target, {
        timeout: 5_000,
        hooks: { afterResponse: () => new Promise<void>((r) => setTimeout(r, 10)) },
      })
      expect(res.response.status).toBe(200)
      await res.response.body?.cancel()
    } finally {
      restore()
    }
  })
})

describe('request — afterResponse is not bounded by the timeout (#204)', () => {
  it('a hook slower than the timeout leaves the response read before it standing', async () => {
    server.use(http.post(`${base}/Document_X`, () => HttpResponse.json({ Ref_Key: 'k' }, { status: 201 })))
    const onError = vi.fn()
    const res = await request(
      { method: 'POST', url: `${base}/Document_X`, headers: { Authorization: auth.header }, body: '{}' },
      { timeout: 300, hooks: { afterResponse: () => new Promise<void>((r) => setTimeout(r, 600)), onError } },
    )
    expect(res.status).toBe(201)
    expect(res.body).toContain('"Ref_Key"')
    expect(onError).not.toHaveBeenCalled()
  })
})

describe('transport — a hook error aborts req.signal without a timeout (#217)', () => {
  const target = { method: 'GET' as const, url: `${base}/X`, headers: { Authorization: auth.header } }

  function ok(status = 200) {
    server.use(
      http.get(`${base}/X`, () =>
        status < 400 ? HttpResponse.json({ value: [] }) : new HttpResponse('upstream down', { status }),
      ),
    )
  }

  for (const [name, call] of [
    ['request', request],
    ['requestStream', requestStream],
  ] as const) {
    it(`${name}: req.signal is set with no timeout and no signal, and a normal call leaves it unaborted`, async () => {
      ok()
      let hookSignal: AbortSignal | undefined
      const res = await call(target, {
        hooks: {
          beforeRequest: (req) => {
            hookSignal = req.signal
          },
        },
      })
      if ('response' in res) void res.response.body?.cancel().catch(() => {})
      expect(hookSignal).toBeInstanceOf(AbortSignal)
      expect(hookSignal?.aborted).toBe(false)
    })

    it(`${name}: beforeRequest throwing aborts req.signal with no timeout`, async () => {
      const hookErr = new Error('token fetch failed')
      let hookSignal: AbortSignal | undefined
      const err = await call(target, {
        hooks: {
          beforeRequest: (req) => {
            hookSignal = req.signal
            throw hookErr
          },
        },
      }).catch((e: unknown) => e)
      expect(err).toBe(hookErr)
      expect(hookSignal?.aborted).toBe(true)
    })

    it(`${name}: afterResponse throwing aborts req.signal with no timeout`, async () => {
      ok()
      const hookErr = new Error('metrics down')
      let hookSignal: AbortSignal | undefined
      const err = await call(target, {
        hooks: {
          afterResponse: (req) => {
            hookSignal = req.signal
            throw hookErr
          },
        },
      }).catch((e: unknown) => e)
      expect(err).toBe(hookErr)
      expect(hookSignal?.aborted).toBe(true)
    })

    it(`${name}: onError throwing its own error on an HTTP error aborts req.signal; rethrowing the one it was handed does not`, async () => {
      ok(500)
      const own = new Error('re-login failed')
      let ownSignal: AbortSignal | undefined
      const err = await call(target, {
        hooks: {
          onError: (req) => {
            ownSignal = req.signal
            throw own
          },
        },
      }).catch((e: unknown) => e)
      expect(err).toBe(own)
      expect(ownSignal?.aborted).toBe(true)

      let handedSignal: AbortSignal | undefined
      const handed = await call(target, {
        hooks: {
          onError: (req, e) => {
            handedSignal = req.signal
            throw e
          },
        },
      }).catch((e: unknown) => e)
      expect(handed).toBeInstanceOf(HTTPError)
      expect(handedSignal?.aborted).toBe(false)
    })

    it(`${name}: onError throwing its own error on a network failure aborts req.signal`, async () => {
      server.use(http.get(`${base}/X`, () => HttpResponse.error()))
      const own = new Error('alerting down')
      let hookSignal: AbortSignal | undefined
      const err = await call(target, {
        hooks: {
          onError: (req) => {
            hookSignal = req.signal
            throw own
          },
        },
      }).catch((e: unknown) => e)
      expect(err).toBe(own)
      expect(hookSignal?.aborted).toBe(true)
    })
  }

  it('a caller signal aborted by a hook error is not the caller’s: their own signal stays unaborted', async () => {
    const caller = new AbortController()
    const err = await request(target, {
      signal: caller.signal,
      hooks: {
        beforeRequest: () => {
          throw new Error('boom')
        },
      },
    }).catch((e: unknown) => e)
    expect((err as Error).message).toBe('boom')
    expect(caller.signal.aborted).toBe(false)
  })
})
