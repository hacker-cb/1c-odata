import {
  BasicAuth,
  type ClientOptions,
  DEFAULT_RETRY_POLICY,
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

  it('DEFAULT_RETRY_POLICY is a ready-made idempotent-methods policy', () => {
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(3)
    expect(DEFAULT_RETRY_POLICY.retryableStatuses).toEqual([502, 503, 504])
    // POST is intentionally excluded (not retry-safe).
    expect(DEFAULT_RETRY_POLICY.retryableMethods).not.toContain('POST')
    expect(DEFAULT_RETRY_POLICY.retryableMethods).toContain('GET')
    expect(DEFAULT_RETRY_POLICY.jitter).toBe('full')
  })

  it('DEFAULT_RETRY_POLICY is deeply frozen — a direct import cannot mutate the shared default', () => {
    expect(Object.isFrozen(DEFAULT_RETRY_POLICY)).toBe(true)
    expect(Object.isFrozen(DEFAULT_RETRY_POLICY.retryableStatuses)).toBe(true)
    expect(Object.isFrozen(DEFAULT_RETRY_POLICY.retryableMethods)).toBe(true)
    expect(() => {
      ;(DEFAULT_RETRY_POLICY as { maxRetries: number }).maxRetries = 99
    }).toThrow(TypeError)
    expect(() => DEFAULT_RETRY_POLICY.retryableStatuses.push(500)).toThrow(TypeError)
  })

  it('DEFAULT_RETRY_POLICY can be spread to customize without mutating the original', () => {
    const custom: RetryPolicy = { ...DEFAULT_RETRY_POLICY, maxRetries: 5 }
    expect(custom.maxRetries).toBe(5)
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(3)
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
