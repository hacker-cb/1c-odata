import type { RequestOptions, RetryPolicy } from '../client/options.js'
import { BusinessError, HTTPError, NetworkError, TimeoutError } from '../errors.js'
import { type RawResponse, type RequestConfig, request, type TransportOptions } from './transport.js'

interface RetryWrapperOpts extends TransportOptions, RequestOptions {}

/**
 * Wrap `request` with optional retry. Skips retry for AbortError, TimeoutError,
 * BusinessError, and any non-retryable status / method.
 */
export async function requestWithRetry(config: RequestConfig, callOpts: RetryWrapperOpts): Promise<RawResponse> {
  const policy = resolvePolicy(callOpts.retry)
  if (!policy) return request(config, callOpts)
  // Cast: HEAD is never in retryableMethods (not in the union type), so it safely skips retry.
  if (!policy.retryableMethods.includes(config.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE')) {
    return request(config, callOpts)
  }

  let lastErr: unknown
  let delayMs = policy.initialDelayMs

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    try {
      return await request(config, callOpts)
    } catch (e) {
      lastErr = e
      // Categorically non-retryable:
      if (e instanceof BusinessError) throw e
      if (e instanceof TimeoutError) throw e
      if (e instanceof Error && e.name === 'AbortError') throw e
      // Status-based: only retryable 5xx/network
      const isRetryableStatus = e instanceof HTTPError && policy.retryableStatuses.includes(e.status)
      const isNetworkError = e instanceof NetworkError
      if (!isRetryableStatus && !isNetworkError) throw e
      if (attempt === policy.maxRetries) throw e

      await sleep(applyJitter(delayMs, policy.jitter))
      delayMs = Math.min(delayMs * policy.backoffMultiplier, policy.maxDelayMs)
    }
  }
  throw lastErr
}

function resolvePolicy(r: RetryPolicy | false | undefined): RetryPolicy | undefined {
  if (r === false) return undefined
  return r
}

function applyJitter(delay: number, mode: 'full' | 'none'): number {
  if (mode === 'none') return delay
  return Math.random() * delay
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
