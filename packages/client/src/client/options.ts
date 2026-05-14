import type { AuthOptions } from '../auth/basic.js'
import type { RequestHooks } from '../hooks/types.js'

/**
 * Per-client default options. See spec §3.6 / §4.10 for full semantics.
 * @public
 */
export interface ClientOptions {
  /** Service root, e.g. `http://1c.example.com/odata/standard.odata`. */
  baseUrl: string
  /** IANA timezone of the 1С server (e.g. 'Europe/Moscow'). REQUIRED. */
  serverTimezone: string

  /** Authentication strategy. Use `BasicAuth({ username, password })`. */
  auth: AuthOptions

  /** Client-level "umbrella" signal — aborts ALL pending requests of this client when fired. */
  signal?: AbortSignal

  /**
   * Default per-request timeout in milliseconds, applied to every request
   * unless `RequestOptions.timeout` overrides it.
   *
   * **Omitting this option entirely disables the timeout** — requests wait
   * indefinitely. Set `0` to explicitly disable. There is NO hidden default
   * cap; production code should set a reasonable value (e.g. `30_000`).
   */
  timeout?: number

  /** Retry policy. `undefined` (default) means no retries. */
  retry?: RetryPolicy

  /** Logging / metrics / header injection hooks. */
  hooks?: RequestHooks
}

/**
 * Per-call overrides. All fields optional — fall back to client defaults.
 * @public
 */
export interface RequestOptions {
  /** Per-call signal — combined with client-level signal via `AbortSignal.any`. */
  signal?: AbortSignal
  /** Override timeout. `0` = disable. */
  timeout?: number
  /** Override retry policy. `false` = disable retries for this call. */
  retry?: RetryPolicy | false
}

/**
 * Retry policy with exponential backoff + optional jitter. Disabled by default.
 * @public
 */
export interface RetryPolicy {
  /** Maximum number of retries (excluding the initial attempt). */
  maxRetries: number
  /** HTTP statuses that trigger retry. Typical: `[502, 503, 504]`. */
  retryableStatuses: number[]
  /** Methods eligible for retry. Default suggestion: `['GET', 'PUT', 'DELETE', 'PATCH']` (POST is NOT retry-safe). */
  retryableMethods: ('GET' | 'PUT' | 'DELETE' | 'PATCH' | 'POST')[]
  /** Initial delay in milliseconds. */
  initialDelayMs: number
  /** Maximum cap on delay between attempts. */
  maxDelayMs: number
  /** Multiplier per attempt: 2 means 200ms → 400ms → 800ms. */
  backoffMultiplier: number
  /** `'full'` = uniform random in `[0, delay]`; `'none'` = exact delay. */
  jitter: 'full' | 'none'
}

/**
 * Per-mutation options. Extends RequestOptions with optimistic-concurrency
 * support.
 *
 * @public
 */
export interface MutationOptions extends RequestOptions {
  /**
   * Optimistic concurrency: when set, library issues a GET before the
   * mutation, compares `DataVersion` against this value, and throws
   * `ConcurrencyError` if they differ. The guard applies ONLY to this
   * mutation — every subsequent mutation must pass `expectVersion` again
   * if needed.
   */
  expectVersion?: string
}
