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
 * Ready-made {@link RetryPolicy} for the common case: 3 retries of idempotent
 * methods on transient gateway statuses (`502/503/504`), exponential backoff
 * (200 ms → 400 ms → 800 ms, capped at 5 s) with full jitter. `POST` is
 * intentionally excluded — it is not retry-safe.
 *
 * Retries stay OFF unless a policy is supplied; opt in by passing this object
 * as `ClientOptions.retry` (or per-call `RequestOptions.retry`), and spread it
 * to tweak a field: `{ ...DEFAULT_RETRY_POLICY, maxRetries: 5 }`. Deeply frozen
 * (object AND its arrays), so a direct import cannot retune the shared default
 * process-wide — spread it to customize.
 *
 * @public
 */
export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze<RetryPolicy>({
  maxRetries: 3,
  retryableStatuses: Object.freeze([502, 503, 504]) as number[],
  retryableMethods: Object.freeze(['GET', 'PUT', 'DELETE', 'PATCH']) as RetryPolicy['retryableMethods'],
  initialDelayMs: 200,
  maxDelayMs: 5_000,
  backoffMultiplier: 2,
  jitter: 'full',
})

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
