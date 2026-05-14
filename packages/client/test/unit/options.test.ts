import {
  BasicAuth,
  type ClientOptions,
  type RequestHooks,
  type RequestOptions,
  type RetryPolicy,
} from '@1c-odata/client'
import { describe, expect, it } from 'vitest'

describe('auth + options', () => {
  it('BasicAuth produces correct Authorization header', () => {
    const auth = BasicAuth({ username: 'user', password: 'pass' })
    expect(auth.scheme).toBe('basic')
    expect(auth.header).toMatch(/^Basic [A-Za-z0-9+/=]+$/)
    // base64 of "user:pass"
    expect(auth.header).toBe('Basic dXNlcjpwYXNz')
  })

  it('ClientOptions accepts full surface from spec §3.6', () => {
    const retry: RetryPolicy = {
      maxRetries: 3,
      retryableStatuses: [502, 503, 504],
      retryableMethods: ['GET', 'PUT', 'DELETE', 'PATCH'],
      initialDelayMs: 200,
      maxDelayMs: 5_000,
      backoffMultiplier: 2,
      jitter: 'full',
    }
    const opts: ClientOptions = {
      baseUrl: 'http://1c.example.com/odata/standard.odata',
      serverTimezone: 'Europe/Moscow',
      auth: BasicAuth({ username: 'u', password: 'p' }),
      timeout: 30_000,
      retry,
    }
    expect(opts.timeout).toBe(30_000)
  })

  it('RequestOptions allows per-call signal/timeout/retry override', () => {
    const ctrl = new AbortController()
    const opts: RequestOptions = { signal: ctrl.signal, timeout: 60_000, retry: false }
    expect(opts.signal).toBe(ctrl.signal)
  })

  it('RequestHooks types support beforeRequest/afterResponse/onError', () => {
    const hooks: RequestHooks = {
      beforeRequest: (req) => req,
      afterResponse: (_req, _res) => {},
      onError: (_req, _err) => {},
    }
    expect(typeof hooks.beforeRequest).toBe('function')
  })
})
