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
   * a fresh one for each attempt a retry makes. It aborts only when the attempt
   * is cut short:
   * - the timeout, over what it bounds (`ClientOptions.timeout`);
   * - the caller's own signal (client- or call-level) — whenever it aborts,
   *   even once the call is over;
   * - a hook's own error ending the call, with or without a timeout — its
   *   reason that error, where nothing aborted it first.
   *
   * It is not aborted when the attempt ends otherwise: on success, on an error
   * from 1С or the network, or when a retry replaces it with the next attempt
   * — work a hook started under an earlier attempt's signal is not cancelled by
   * the retry. Hand it to work a hook starts so that work stops when the call is
   * cut short; work that must end with the call, the hook awaits or bounds with
   * a signal of its own (`RequestHooks`, "What `req.signal` ends"). Optional
   * only so a hand-built event type-checks.
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
 * An exception a hook throws while the call waits for it reaches the caller
 * as is: it is not wrapped in a library error, not passed to `onError`, and
 * never retried — a hook that
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
 *
 * **How long the call waits for a hook.** A caller's abort (its own
 * `AbortSignal`, client- or call-level) ends the wait for every hook but one —
 * `afterResponse` on a buffered call, where the response is already in hand
 * and a write 1С has made must not turn into an abort. The `timeout` ends it
 * only while it still bounds the exchange. A wait that ends early leaves the
 * hook to finish by itself, under an aborted `req.signal`, and what it throws
 * later is dropped — it neither reaches the caller nor stops a retry. It is the promise a hook returns that is waited for: its
 * synchronous part runs before the call goes on either way.
 *
 * - `beforeRequest` — timeout and abort. The timeout: a `TimeoutError`
 *   (`onError` called). The abort: its reason.
 * - `afterResponse`, buffered call — neither. The response, however long the
 *   hook takes.
 * - `afterResponse`, streamed read (`readStream`) — timeout and abort. A
 *   `TimeoutError` (`onError` called) or the abort's reason; the unread body
 *   is cancelled.
 * - `onError` with a `TimeoutError` — not waited for at all: the
 *   `TimeoutError` at once.
 * - `onError` with a `NetworkError` — what is left of the timeout, and abort.
 *   Past the deadline, that `NetworkError` — retried as one where a retry
 *   policy allows, the outrun hook still running. The abort: its reason.
 * - `onError` with an `HTTPError` (or a subclass), or a `ParseError` from
 *   mapping an error response — abort only: the exchange is over and the
 *   timeout stopped with the body read. The abort: its reason. An abort that
 *   came before the hook started (during a buffered `afterResponse`, which
 *   does not hear it) leaves the error standing: the hook is called but not
 *   waited for.
 *
 * With neither a `timeout` nor a signal, every hook is waited for in full.
 *
 * **What `req.signal` ends.** It aborts only when its attempt is cut short —
 * the timeout, the caller's abort, a hook's own error (`RequestEvent.signal`).
 * An attempt that ends otherwise — a response, an HTTP or network error, an
 * attempt a retry replaces — leaves it unaborted, so work a hook started
 * without awaiting it runs on past the attempt and the call: a log write
 * `onError` fires and forgets is not cut off by the retry or by the call
 * returning. Only the caller's own signal still ends it. Work that must not
 * outlive the call, the hook awaits — the call waits for it as listed above —
 * or bounds itself:
 *
 * ```ts
 * onError: (req, err) => {
 *   // Ends with the call cut short, or after 5 s whatever happens to the call.
 *   const signal = AbortSignal.any([AbortSignal.timeout(5_000), ...(req.signal ? [req.signal] : [])])
 *   void shipLog({ url: req.url, err }, { signal })
 * }
 * ```
 * @public
 */
export interface RequestHooks {
  /** Before request goes on the wire. Return a (possibly modified) RequestEvent to inject headers / correlation IDs. */
  // biome-ignore lint/suspicious/noConfusingVoidType: void is intentional — it keeps side-effect-only `(req) => void` hooks assignable; the RequestEvent return is the optional "replace the event" path.
  beforeRequest?: (req: RequestEvent) => void | RequestEvent | Promise<void | RequestEvent>
  /**
   * After response is received and parsed. Bounded on a streamed read
   * (`readStream`, `body` undefined) but not on a buffered call — see "How
   * long the call waits for a hook" above.
   */
  afterResponse?: (req: RequestEvent, res: ResponseEvent) => void | Promise<void>
  /**
   * When an error (network/timeout/HTTP) is about to be thrown. How long the
   * call waits for it: see "How long the call waits for a hook" above — on a
   * timeout not at all. To be sure a side effect of it finished — a log
   * flushed — await that in your own code, not through the call's rejection.
   */
  onError?: (req: RequestEvent, err: ODataError) => void | Promise<void>
}
