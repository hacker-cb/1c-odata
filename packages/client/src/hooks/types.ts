import type { ODataError } from '../errors.js'

/**
 * Wire-level snapshot of the outgoing request, given to `beforeRequest` and
 * passed back into `afterResponse` / `onError`.
 * @public
 */
export interface RequestEvent {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  url: string
  headers: Record<string, string>
  body?: string
  /**
   * The signal of this attempt — set by the library on every request it makes,
   * a fresh one for each attempt a retry makes. It aborts when the attempt is
   * cut short: the timeout, over what it bounds (`ClientOptions.timeout`),
   * the caller's own signal
   * (client- or call-level), or a hook's own error ending the call (with or
   * without a timeout; its reason that error, where nothing aborted it first). Hand it to work a hook starts so
   * that work stops when the call is cut short; it is not aborted when the
   * call completes or fails otherwise. Optional only so a hand-built event
   * type-checks.
   */
  signal?: AbortSignal
}

/**
 * Wire-level snapshot of the incoming response.
 * @public
 */
export interface ResponseEvent {
  status: number
  statusText: string
  headers: Record<string, string>
  body?: string
  durationMs: number
}

/**
 * Lifecycle hooks for logging, metrics, header injection. See spec §4.10.
 *
 * An exception a hook throws reaches the caller as is: it is not wrapped in a
 * library error, not passed to `onError`, and never retried — a hook that
 * throws on a 401 to trigger a re-login gets its own error back. The one
 * exception: `onError` rethrowing the very error it was handed leaves it the
 * library's error, retried as its type and status say — so "log and rethrow"
 * keeps retry working. A hook's own exception ends the call, and `req.signal`
 * is aborted with it, so work the hook left running under that signal stops:
 *
 * ```ts
 * onError: (req, err) => {
 *   log.warn({ url: req.url, err })
 *   throw err // still the library's error: a retryable 503 is retried
 * }
 * ```
 * @public
 */
export interface RequestHooks {
  /** Before request goes on the wire. Return a (possibly modified) RequestEvent to inject headers / correlation IDs. */
  // biome-ignore lint/suspicious/noConfusingVoidType: void is intentional — it keeps side-effect-only `(req) => void` hooks assignable; the RequestEvent return is the optional "replace the event" path.
  beforeRequest?: (req: RequestEvent) => void | RequestEvent | Promise<void | RequestEvent>
  /**
   * After response is received and parsed. Not bounded by the request timeout
   * on a buffered call — the response is already read and stands however long
   * the hook takes. On a streamed read (`readStream`, `body` undefined) it is:
   * a hook outlasting the timeout fails the call with a `TimeoutError` and the
   * unread body is cancelled.
   */
  afterResponse?: (req: RequestEvent, res: ResponseEvent) => void | Promise<void>
  /** When an error (network/timeout/HTTP) is about to be thrown. */
  onError?: (req: RequestEvent, err: ODataError) => void | Promise<void>
}
