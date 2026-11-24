import { BasicAuth, HTTPError, NetworkError, type RequestEvent, TimeoutError } from '@1c-odata/client'
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
    expect(err.message).toBe('Network error: fetch failed (ENOTFOUND: getaddrinfo ENOTFOUND 1c.example)')
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

  it('keeps the bare message when there is no cause, or it adds nothing', async () => {
    expect((await networkErrorFor(fetchFailed())).message).toBe('Network error: fetch failed')
    expect((await networkErrorFor(new Error('socket hang up', { cause: new Error('socket hang up') }))).message).toBe(
      'Network error: socket hang up',
    )
    expect((await networkErrorFor(fetchFailed({ unrelated: true }))).message).toBe('Network error: fetch failed')
  })
})
