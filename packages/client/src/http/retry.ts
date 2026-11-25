import type { RequestOptions, RetryPolicy } from '../client/options.js'
import { BusinessError, HTTPError, NetworkError, TimeoutError } from '../errors.js'
import { type AttemptTrace, type RawResponse, type RequestConfig, request, type TransportOptions } from './transport.js'

interface RetryWrapperOpts extends TransportOptions, RequestOptions {}

/**
 * Wrap `request` with optional retry. Skips retry for a hook's own exception,
 * a caller's abort, TimeoutError, BusinessError, and any non-retryable status,
 * or method — the method that was sent, after `beforeRequest`.
 */
export async function requestWithRetry(config: RequestConfig, callOpts: RetryWrapperOpts): Promise<RawResponse> {
  const policy = resolvePolicy(callOpts.retry)
  if (!policy) return request(config, callOpts)

  let delayMs = policy.initialDelayMs
  for (let attempt = 0; ; attempt++) {
    const trace: AttemptTrace = { threw: false }
    try {
      return await request(config, callOpts, trace)
    } catch (e) {
      if (attempt >= policy.maxRetries || !mayRetry(e, trace, policy, config, callOpts)) throw e
      await sleep(applyJitter(delayMs, policy.jitter))
      delayMs = Math.min(delayMs * policy.backoffMultiplier, policy.maxDelayMs)
    }
  }
}

/** Whether the attempt `trace` records, failed with `e`, may be repeated under `policy`. */
function mayRetry(
  e: unknown,
  trace: AttemptTrace,
  policy: RetryPolicy,
  config: RequestConfig,
  callOpts: RetryWrapperOpts,
): boolean {
  // The method that was sent — `beforeRequest` may have replaced the one asked for.
  // Cast: HEAD is never in retryableMethods (not in the union type), so it never retries.
  const method = trace.method ?? config.method
  if (!policy.retryableMethods.includes(method as RetryPolicy['retryableMethods'][number])) return false
  // An attempt a hook's own exception ended, whatever its type (a nested
  // client call inside a hook can throw a NetworkError).
  if (trace.threw) return false
  // A caller's abort, whatever reason it aborted with.
  if (config.signal?.aborted || callOpts.signal?.aborted) return false
  if (e instanceof BusinessError || e instanceof TimeoutError) return false
  if (e instanceof Error && e.name === 'AbortError') return false
  // Status-based: only retryable 5xx/network
  return (e instanceof HTTPError && policy.retryableStatuses.includes(e.status)) || e instanceof NetworkError
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
