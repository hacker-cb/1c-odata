import type { RequestOptions } from '../client/options.js'
import { NetworkError, type RequestContext, TimeoutError } from '../errors.js'
import type { RequestEvent, RequestHooks, ResponseEvent } from '../hooks/types.js'
import { mapResponseToError } from './error-mapping.js'

/**
 * Result of a successful request — parsed body left to caller.
 */
export interface RawResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  durationMs: number
}

/**
 * Internal request configuration. Caller (V3 client) builds this from the
 * service-level call (e.g. `query.get()`).
 */
export interface RequestConfig {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  url: string
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
}

/**
 * Subset of ClientOptions actually consumed by the transport layer.
 */
export interface TransportOptions {
  timeout?: number
  hooks?: RequestHooks
  signal?: AbortSignal
}

/**
 * Result of a successful streaming request — caller is responsible for
 * consuming `response.body` (e.g. piping into a file). Not returned to a
 * retry layer; streaming + retry has body-replay semantics we don't need.
 */
export interface StreamResponse {
  response: Response
  durationMs: number
}

interface PreparedRequest {
  reqEvent: RequestEvent
  fetchInit: RequestInit
  start: number
  timeoutId: ReturnType<typeof setTimeout> | undefined
  timeoutSignal: AbortController | undefined
  timeoutMs: number | undefined
}

/**
 * Build the `RequestEvent` + `RequestInit` shared between text and stream
 * dispatch paths. Runs the `beforeRequest` hook, combines signals, and
 * starts the timeout.
 *
 * The timeout covers the hook too: it starts first and the hook sees it in
 * `req.signal`. The wait for the hook ends with that signal — a timeout while
 * it runs fails the call with a `TimeoutError` (`onError` fired), a caller's
 * abort with the abort's reason, even where the hook ignores the signal. A
 * hook that throws fails the call with its own error, unchanged; the call ends
 * there, so its timer is cleared and `req.signal` aborted — work the hook left
 * running under it is cancelled rather than left without a deadline.
 */
async function prepareRequest(
  config: RequestConfig,
  callOpts: TransportOptions & RequestOptions,
  trace: AttemptTrace | undefined,
): Promise<PreparedRequest> {
  const start = Date.now()

  // Combine signals: client.signal + per-call.signal + timeout signal.
  const signals: AbortSignal[] = []
  if (callOpts.signal) signals.push(callOpts.signal)
  if (config.signal) signals.push(config.signal)
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let timeoutSignal: AbortController | undefined
  const timeoutMs = callOpts.timeout
  if (timeoutMs && timeoutMs > 0) {
    timeoutSignal = new AbortController()
    timeoutId = setTimeout(() => timeoutSignal?.abort(), timeoutMs)
    signals.push(timeoutSignal.signal)
  }
  const combined = signals.length > 0 ? AbortSignal.any(signals) : undefined

  // Build the RequestEvent for hooks
  let reqEvent: RequestEvent = {
    method: config.method,
    url: config.url,
    headers: { ...config.headers },
    ...(config.body !== undefined ? { body: config.body } : {}),
    ...(combined !== undefined ? { signal: combined } : {}),
  }

  // beforeRequest hook may mutate headers, body, etc.
  // Read inside runHook, so even a throwing `hooks` getter counts as the hook's.
  try {
    const result = await settleWithin(
      runHook(() => callOpts.hooks?.beforeRequest?.(reqEvent), trace),
      combined,
    )
    if (result) reqEvent = result
  } catch (e) {
    // The callers' `finally` that clears the timer is not reached from here.
    if (timeoutId) clearTimeout(timeoutId)
    // The wait ended with the request signal — the deadline or the caller's
    // abort — rather than with the hook: classified as on the wire (a
    // TimeoutError with onError, or the caller's own reason).
    if (combined?.aborted && e === combined.reason) {
      await translateAndFireError(e, reqEvent, callOpts.hooks, timeoutSignal, timeoutMs, combined, trace)
    }
    // The hook's own failure: the call ends here, and so does what the hook
    // left running under req.signal.
    timeoutSignal?.abort()
    throw e
  }
  // Read once: the method the trace records is the method sent.
  const method = reqEvent.method
  if (trace) trace.method = method

  const fetchInit: RequestInit = {
    method,
    headers: reqEvent.headers,
    ...(combined !== undefined ? { signal: combined } : {}),
    ...(reqEvent.body !== undefined ? { body: reqEvent.body } : {}),
  }

  return { reqEvent, fetchInit, start, timeoutId, timeoutSignal, timeoutMs }
}

/**
 * Await `value`, rejecting with `signal`'s abort reason the moment it aborts —
 * whether or not the work behind `value` honours the signal. Work outrun by
 * the signal is left to settle on its own (the race keeps its rejection handled).
 */
async function settleWithin<T>(value: T | PromiseLike<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return value
  let onAbort = (): void => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([value, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Certificate-trust failures — the server's chain does not verify against the
 * CAs Node trusts. Typical behind a corporate / Active Directory CA or a
 * TLS-inspecting proxy, and fixed by trusting that CA, not by code changes.
 */
const TLS_TRUST_CODES: ReadonlySet<string> = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
])

const TLS_TRUST_HINT =
  'the server certificate is not trusted by Node — add the issuing CA with NODE_EXTRA_CA_CERTS=/path/to/ca.pem, ' +
  'or trust the OS certificate store with NODE_USE_SYSTEM_CA=1 (README "Network configuration")'

/** How deep {@link networkErrorMessage} follows a `cause` chain. */
const MAX_CAUSE_DEPTH = 4

interface Reason {
  code: string | undefined
  message: string
}

/** The `code` / trimmed `message` of an error-like value (either may be absent). */
function reasonOf(v: unknown): Reason {
  if (typeof v !== 'object' || v === null) return { code: undefined, message: '' }
  const { code, message } = v as { code?: unknown; message?: unknown }
  return {
    code: typeof code === 'string' && code !== '' ? code : undefined,
    message: typeof message === 'string' ? message.trim() : '',
  }
}

/** `CODE: message` — the code dropped where the message already names it, '' for neither. */
function reasonText({ code, message }: Reason): string {
  if (code === undefined) return message
  if (message === '') return code
  return message.includes(code) ? message : `${code}: ${message}`
}

/**
 * Every reason under a caught error: its `cause` chain, and the per-attempt
 * errors of an `AggregateError` with their own chains — undici's multi-address
 * connect failure has an EMPTY message with the attempts in `errors[]`, and a
 * proxy failure wraps the TLS error one level deeper (`UND_ERR_PRX_TLS` → the
 * certificate code). The caught error itself contributes only its code (its
 * message is the base of the NetworkError's). Bounded by depth.
 */
function collectReasons(v: unknown, depth = 0, out: Reason[] = []): Reason[] {
  if (depth > MAX_CAUSE_DEPTH || typeof v !== 'object' || v === null) return out
  const reason = reasonOf(v)
  if (depth > 0) out.push(reason)
  else if (reason.code !== undefined && !reason.message.includes(reason.code))
    out.push({ code: reason.code, message: '' })
  const errors = (v as { errors?: unknown }).errors
  if (Array.isArray(errors)) for (const sub of errors) collectReasons(sub, depth + 1, out)
  return collectReasons((v as { cause?: unknown }).cause, depth + 1, out)
}

/** A bare error code — `ECONNREFUSED`, `UND_ERR_SOCKET`. */
const BARE_CODE = /^[A-Z][A-Z0-9_]*$/

/**
 * Build the `NetworkError` message. undici's own message is always the bare
 * `fetch failed`; the real reason — `ECONNREFUSED`, `ENOTFOUND`, a TLS
 * verification code — sits under `e.cause` (see {@link collectReasons}). Fold
 * it into the message so it survives every surface that shows only `.message`
 * (the MCP server among them); a certificate-trust code adds a hint. Reading
 * the error must never fail the translation: anything thrown while inspecting
 * it (a hostile `cause` getter) falls back to the bare message.
 */
function networkErrorMessage(e: unknown): string {
  let own = ''
  try {
    own = String((e as { message?: unknown } | undefined)?.message ?? '').trim()
  } catch {
    // A throwing `message` getter: report the failure without it.
  }
  const base = `Network error: ${own || 'unknown'}`
  try {
    const reasons = collectReasons(e)
    const unique = [...new Set(reasons.map(reasonText))].filter((t) => t !== '' && t !== own)
    // A bare code (an AggregateError's own) is dropped where a fuller text already names it.
    const texts = unique.filter((t) => !(BARE_CODE.test(t) && unique.some((o) => o !== t && o.includes(t))))
    const trust = reasons.some((r) => r.code !== undefined && TLS_TRUST_CODES.has(r.code))
    const detail = texts.length > 0 ? ` (${texts.join('; ')})` : ''
    return `${base}${detail}${trust ? `; ${TLS_TRUST_HINT}` : ''}`
  } catch {
    return base
  }
}

/**
 * One call's record for retry: whether a hook's own exception ended it, and
 * the method actually sent. Retry hands a fresh one to every attempt — per
 * call, so no other request's hooks can touch it. Written by the transport,
 * read by `http/retry.ts`; reached from outside only through
 * `@1c-odata/client/internal`, which is not semver-stable.
 */
export interface AttemptTrace {
  threw: boolean
  /** The method sent, after `beforeRequest` — set once the hook has run. */
  method?: RequestEvent['method']
}

/**
 * Call a hook (synchronously, as the caller wrote it — `this` intact) and
 * record in `trace` that what it throws is the hook's own. The one exception:
 * `onError` rethrowing `handed`, the very error it was given, leaves that the
 * library's error, retried as its type and status say.
 */
async function runHook<T>(
  call: () => T | PromiseLike<T>,
  trace: AttemptTrace | undefined,
  handed?: unknown,
): Promise<T> {
  try {
    return await call()
  } catch (e) {
    if (trace !== undefined && (handed === undefined || e !== handed)) trace.threw = true
    throw e
  }
}

/**
 * Translate an exception from the wire — the fetch, or reading the body —
 * into the typed error hierarchy and fire the `onError` hook. Shared between
 * text and stream paths. Never handed a hook's own exception: those reach the
 * caller unchanged.
 */
async function translateAndFireError(
  e: unknown,
  reqEvent: RequestEvent,
  hooks: RequestHooks | undefined,
  timeoutSignal: AbortController | undefined,
  timeoutMs: number | undefined,
  requestSignal: AbortSignal | null | undefined,
  trace: AttemptTrace | undefined,
): Promise<never> {
  const request: RequestContext = { method: reqEvent.method, url: reqEvent.url }
  // The request signal carries the reason of whichever source aborted it
  // first: a timeout only where the timer was first.
  const timedOut = timeoutSignal?.signal.aborted === true && requestSignal?.reason === timeoutSignal.signal.reason
  // timeoutMs is paired with timeoutSignal in prepareRequest: set whenever the signal can fire.
  if (timedOut && timeoutMs !== undefined) {
    const err = new TimeoutError(`Request timed out after ${timeoutMs}ms`, {
      timeoutMs,
      cause: e,
      request,
    })
    await runHook(() => hooks?.onError?.(reqEvent, err), trace, err)
    throw err
  }
  // A caller's abort is no network failure and nothing to retry: the caller
  // gets back its own reason — an AbortError, or whatever it aborted with.
  if (requestSignal?.aborted) throw requestSignal.reason
  if (e instanceof Error && e.name === 'AbortError') throw e
  // Anything else failed on the wire: a network-level error
  const err = new NetworkError(networkErrorMessage(e), { cause: e, request })
  await runHook(() => hooks?.onError?.(reqEvent, err), trace, err)
  throw err
}

/**
 * Execute one HTTP request. Handles timeout, signal combine, hooks invocation,
 * and error mapping. NO retry — that's a layer above (`http/retry.ts`).
 *
 * @throws {TimeoutError} when `callOpts.timeout` elapses before the response
 *   is received.
 * @throws {NetworkError} on transport-level failure (DNS, connection reset,
 *   TLS handshake, etc.). Wraps the underlying cause in `.cause`.
 * @throws {HTTPError} (and its subclasses `BusinessError`, `ConcurrencyError`,
 *   `PermissionError`) when the server returns HTTP ≥ 400. The exact subclass
 *   is decided by `mapResponseToError` based on status + `odata.error.code`.
 * @throws {ParseError} when a JSON/XML error body is unparseable (invalid JSON
 *   or a missing `odata.error` wrapper). A non-OData body (HTML/proxy page,
 *   wrong path, over-long URL) instead yields an `HTTPError` with
 *   `errorFormat: 'none'` and the status preserved.
 * @throws {DOMException} `AbortError` (`error.name === 'AbortError'`) is
 *   rethrown unchanged when the user-issued `AbortSignal` fires.
 * @throws whatever a hook throws, unchanged — not wrapped, not passed to
 *   `onError`, and so never retried.
 */
export async function request(
  config: RequestConfig,
  callOpts: TransportOptions & RequestOptions,
  trace?: AttemptTrace,
): Promise<RawResponse> {
  const prepared = await prepareRequest(config, callOpts, trace)
  const { reqEvent, fetchInit, start, timeoutId, timeoutSignal, timeoutMs } = prepared

  try {
    // Only the wire — the fetch and reading the body — can fail as a network
    // error. Hooks and error mapping run outside this `try`: what they throw
    // reaches the caller unchanged, never a retryable NetworkError.
    let response: Response
    let body: string
    try {
      // Use globalThis.fetch so MSW can intercept in tests.
      // Node 22+ globalThis.fetch is undici-based; transport-level options
      // (TLS/proxy) are configured process-wide via env vars / CLI flags,
      // not per-request.
      response = await globalThis.fetch(reqEvent.url, fetchInit)
      body = await response.text()
    } catch (e) {
      if (timeoutId) clearTimeout(timeoutId)
      return await translateAndFireError(e, reqEvent, callOpts.hooks, timeoutSignal, timeoutMs, fetchInit.signal, trace)
    }
    const headers: Record<string, string> = {}
    response.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v
    })

    const durationMs = Date.now() - start
    const resEvent: ResponseEvent = {
      status: response.status,
      statusText: response.statusText,
      headers,
      body,
      durationMs,
    }

    const { hooks } = callOpts
    await runHook(() => hooks?.afterResponse?.(reqEvent, resEvent), trace)

    if (response.status >= 400) {
      const err = await mapResponseToError(response.status, response.statusText, headers, body, {
        method: reqEvent.method,
        url: reqEvent.url,
      })
      await runHook(() => hooks?.onError?.(reqEvent, err), trace, err)
      throw err
    }

    return { status: response.status, statusText: response.statusText, headers, body, durationMs }
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

/**
 * Execute one HTTP request and return the native `Response` with the body
 * stream UNCONSUMED — the caller pipes/parses `response.body` directly.
 *
 * Honours the same timeout, signal-combine, and `beforeRequest`/`onError`
 * hooks as `request()`. The `afterResponse` hook fires on receipt of the
 * response headers (with `body: undefined` in the `ResponseEvent`, since the
 * body has not been read).
 *
 * Used by V3 `readStream` (`ХранилищеЗначения` / binary content), where
 * buffering via `response.text()` would corrupt non-UTF-8 bytes (JPEG, PDF,
 * etc.).
 *
 * NOTE: NOT integrated with retry. Streaming + retry has body-replay
 * semantics that don't apply to V3's read-only stream endpoints. If you need
 * retry on a stream GET, wrap this call yourself (each attempt re-issues the
 * request from scratch).
 *
 * @throws {TimeoutError} when `callOpts.timeout` elapses before headers arrive.
 * @throws {NetworkError} on transport-level failure (DNS, connection reset,
 *   TLS handshake, etc.).
 * @throws {HTTPError} (and subclasses) when the server returns HTTP ≥ 400.
 *   Note: for the error path the body IS consumed in order to map to the
 *   typed error; the caller never sees the body in that case.
 * @throws {ParseError} when a JSON/XML error body is unparseable. A non-OData
 *   body yields an `HTTPError` with `errorFormat: 'none'` (status preserved).
 * @throws {DOMException} `AbortError` (`error.name === 'AbortError'`) is
 *   rethrown unchanged when the user-issued `AbortSignal` fires.
 * @throws whatever a hook throws, unchanged — not wrapped, not passed to
 *   `onError`.
 */
export async function requestStream(
  config: RequestConfig,
  callOpts: TransportOptions & RequestOptions,
  trace?: AttemptTrace,
): Promise<StreamResponse> {
  const prepared = await prepareRequest(config, callOpts, trace)
  const { reqEvent, fetchInit, start, timeoutId, timeoutSignal, timeoutMs } = prepared

  try {
    // As in `request()`: only the fetch and reading an error body are the wire.
    let response: Response
    try {
      response = await globalThis.fetch(reqEvent.url, fetchInit)
    } catch (e) {
      if (timeoutId) clearTimeout(timeoutId)
      return await translateAndFireError(e, reqEvent, callOpts.hooks, timeoutSignal, timeoutMs, fetchInit.signal, trace)
    }

    const headers: Record<string, string> = {}
    response.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v
    })

    const durationMs = Date.now() - start
    const resEvent: ResponseEvent = {
      status: response.status,
      statusText: response.statusText,
      headers,
      durationMs,
    }

    const { hooks } = callOpts
    try {
      await runHook(() => hooks?.afterResponse?.(reqEvent, resEvent), trace)
    } catch (e) {
      // The caller never gets this response: release its connection.
      response.body?.cancel().catch(() => {})
      throw e
    }

    // For error responses we DO consume the body to map to a typed error —
    // the caller never gets a chance to read it. For success, the body is
    // left untouched and returned to the caller.
    if (response.status >= 400) {
      let body: string
      try {
        body = await response.text()
      } catch (e) {
        if (timeoutId) clearTimeout(timeoutId)
        return await translateAndFireError(
          e,
          reqEvent,
          callOpts.hooks,
          timeoutSignal,
          timeoutMs,
          fetchInit.signal,
          trace,
        )
      }
      const err = await mapResponseToError(response.status, response.statusText, headers, body, {
        method: reqEvent.method,
        url: reqEvent.url,
      })
      await runHook(() => hooks?.onError?.(reqEvent, err), trace, err)
      throw err
    }

    return { response, durationMs }
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}
