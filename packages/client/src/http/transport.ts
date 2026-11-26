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
  /** Ends the call early — aborted when a hook's own error ends it, timeout or not. */
  callController: AbortController
}

/**
 * Build the `RequestEvent` + `RequestInit` shared between text and stream
 * dispatch paths. Runs the `beforeRequest` hook, combines signals, and
 * starts the timeout.
 *
 * A request whose signal has already aborted ends before the hook is called,
 * with the abort's reason. The timeout covers the hook too: it starts first
 * and the hook sees it in `req.signal`. The wait for the hook ends with that signal — a timeout while
 * it runs fails the call with a `TimeoutError` (`onError` fired), a caller's
 * abort with the abort's reason, even where the hook ignores the signal. A
 * hook that throws fails the call with its own error, unchanged; the call ends
 * there, so its timer is cleared and `req.signal` aborted — work the hook left
 * running under it is cancelled rather than left without a deadline. That holds
 * with no timeout too: the call's own controller is always part of the signal,
 * so `req.signal` is always set.
 */
async function prepareRequest(
  config: RequestConfig,
  callOpts: TransportOptions & RequestOptions,
  trace: AttemptTrace | undefined,
): Promise<PreparedRequest> {
  const start = Date.now()

  // Combine signals: client.signal + per-call.signal + timeout signal + the
  // call's own controller, which a hook's own error aborts.
  const callController = new AbortController()
  const signals: AbortSignal[] = [callController.signal]
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
  const combined = AbortSignal.any(signals)

  // Build the RequestEvent for hooks
  let reqEvent: RequestEvent = {
    method: config.method,
    url: config.url,
    headers: { ...config.headers },
    ...(config.body !== undefined ? { body: config.body } : {}),
    signal: combined,
  }

  // beforeRequest hook may mutate headers, body, etc.
  // Read inside runHook, so even a throwing `hooks` getter counts as the hook's.
  try {
    // Already aborted (a caller's abort before the call, or during a retry's
    // pause): end here, before the hook is called — the same path as an abort
    // while it runs.
    if (combined.aborted) throw combined.reason
    const result = await settleWithin(
      runHook(() => callOpts.hooks?.beforeRequest?.(reqEvent), trace),
      combined,
    )
    if (result) reqEvent = result
    // The event keeps the call's signal — the fetch runs under it, and later
    // hooks are promised it — whether the hook returned a replacement without
    // one or dropped it from the event it was given.
    reqEvent = withSignal(reqEvent, combined)
  } catch (e) {
    // The callers' `finally` that clears the timer is not reached from here.
    if (timeoutId) clearTimeout(timeoutId)
    // The wait ended with the request signal — the deadline or the caller's
    // abort — rather than with the hook: classified as on the wire (a
    // TimeoutError with onError, or the caller's own reason).
    if (combined.aborted && e === combined.reason) {
      await translateAndFireError(
        e,
        reqEvent,
        () => callOpts.hooks,
        timeoutSignal,
        timeoutMs,
        combined,
        trace,
        callController,
      )
    }
    // The hook's own failure: the call ends here, and so does what the hook
    // left running under req.signal — the hook's error its reason.
    callController.abort(e)
    throw e
  }
  // Read once: the method the trace records is the method sent.
  const method = reqEvent.method
  if (trace) trace.method = method

  const fetchInit: RequestInit = {
    method,
    headers: reqEvent.headers,
    signal: combined,
    ...(reqEvent.body !== undefined ? { body: reqEvent.body } : {}),
  }

  return { reqEvent, fetchInit, start, timeoutId, timeoutSignal, timeoutMs, callController }
}

/**
 * `event` carrying `signal`: set in place where it lacks it, so the event a
 * hook returned stays the one later hooks see (its prototype and identity
 * intact); a copy only where the object refuses the write (frozen).
 */
function withSignal(event: RequestEvent, signal: AbortSignal): RequestEvent {
  if (event.signal === signal || Reflect.set(event, 'signal', signal)) return event
  return { ...event, signal }
}

/**
 * Await `value`, rejecting with `given`'s abort reason the moment it aborts —
 * whether or not the work behind `value` honours the signal. Work outrun by
 * the signal is left to settle on its own (the race keeps its rejection handled).
 * Shared with the retry pause (`http/retry.ts`).
 *
 * @internal
 */
export async function settleWithin<T>(value: T | PromiseLike<T>, given: AbortSignal | undefined): Promise<T> {
  if (!given) return value
  // Heard through a signal derived from it: only a real abort ends the wait,
  // whatever another listener on `given` does (stopImmediatePropagation, a
  // forged 'abort' event) — the hook itself may hold one on `req.signal`.
  const signal = AbortSignal.any([given])
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
 * Run `afterResponse` on a streamed response bounded by the request signal, as
 * `beforeRequest` is: the wait for it ends with the signal — the deadline or a
 * caller's abort — whether or not the hook honours `req.signal`. A signal
 * already aborted when the headers arrive, or once the hook has settled, ends
 * it too: the unread body is cut by then. Rejects with
 * the hook's own error unchanged, or with the signal's reason — which
 * {@link isAbort} tells apart.
 */
async function runStreamAfterResponse(
  hooks: RequestHooks | undefined,
  reqEvent: RequestEvent,
  resEvent: ResponseEvent,
  signal: AbortSignal | null | undefined,
  trace: AttemptTrace | undefined,
): Promise<void> {
  if (signal?.aborted) throw signal.reason
  await settleWithin(
    runHook(() => hooks?.afterResponse?.(reqEvent, resEvent), trace),
    signal ?? undefined,
  )
  if (signal?.aborted) throw signal.reason
}

/**
 * Await a hook already started, and where it fails with an error of its own —
 * anything but `handed`, the error `onError` was given — abort the call's
 * controller: the call ends with that error, and so does what the hook left
 * running under `req.signal`. Aborted only once the hook has settled, so the
 * abort never races the hook's error to the caller.
 */
async function endOnHookError<T>(hook: Promise<T>, call: AbortController, handed?: unknown): Promise<T> {
  try {
    return await hook
  } catch (e) {
    if (handed === undefined || e !== handed) call.abort(e)
    throw e
  }
}

/** Whether `e` is the request signal's own abort — not a hook's error. */
function isAbort(e: unknown, signal: AbortSignal | null | undefined): boolean {
  return signal?.aborted === true && e === signal.reason
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
  readHooks: () => RequestHooks | undefined,
  timeoutSignal: AbortController | undefined,
  timeoutMs: number | undefined,
  requestSignal: AbortSignal | null | undefined,
  trace: AttemptTrace | undefined,
  callController: AbortController,
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
    await endOnHookError(
      runHook(() => readHooks()?.onError?.(reqEvent, err), trace, err),
      callController,
      err,
    )
    throw err
  }
  // A caller's abort is no network failure and nothing to retry: the caller
  // gets back its own reason — an AbortError, or whatever it aborted with.
  if (requestSignal?.aborted) throw requestSignal.reason
  if (e instanceof Error && e.name === 'AbortError') throw e
  // Anything else failed on the wire: a network-level error
  const err = new NetworkError(networkErrorMessage(e), { cause: e, request })
  await endOnHookError(
    runHook(() => readHooks()?.onError?.(reqEvent, err), trace, err),
    callController,
    err,
  )
  throw err
}

/**
 * Execute one HTTP request. Handles timeout, signal combine, hooks invocation,
 * and error mapping. NO retry — that's a layer above (`http/retry.ts`).
 *
 * @throws {TimeoutError} when `callOpts.timeout` elapses before the response
 *   is received — `beforeRequest` included. `afterResponse` is not bounded by
 *   it: it runs once the body is read, and the response stands however long
 *   the hook takes.
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
  const { reqEvent, fetchInit, start, timeoutId, timeoutSignal, timeoutMs, callController } = prepared

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
      // The exchange with 1С is over: the timeout bounded it and stops here, so
      // it never aborts req.signal under afterResponse / onError below.
      if (timeoutId) clearTimeout(timeoutId)
    } catch (e) {
      if (timeoutId) clearTimeout(timeoutId)
      return await translateAndFireError(
        e,
        reqEvent,
        () => callOpts.hooks,
        timeoutSignal,
        timeoutMs,
        fetchInit.signal,
        trace,
        callController,
      )
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

    // Not bounded by the timeout: the exchange with 1С is over and the body in
    // hand, so a slow hook must not turn a write 1С has made into a TimeoutError.
    // `hooks` read inside each hook's run: a throwing getter is the hook's own error.
    await endOnHookError(
      runHook(() => callOpts.hooks?.afterResponse?.(reqEvent, resEvent), trace),
      callController,
    )

    if (response.status >= 400) {
      const err = await mapResponseToError(response.status, response.statusText, headers, body, {
        method: reqEvent.method,
        url: reqEvent.url,
      })
      await endOnHookError(
        runHook(() => callOpts.hooks?.onError?.(reqEvent, err), trace, err),
        callController,
        err,
      )
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
 * body has not been read). Unlike in `request()`, the timeout bounds it —
 * the timer would otherwise cut the unread body under the caller: a timeout
 * while it runs is a `TimeoutError` (`onError` fired), a caller's abort its
 * reason, and the body is cancelled either way. The timeout stops once this
 * resolves: reading the body is not bounded by it.
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
 * @throws {TimeoutError} when `callOpts.timeout` elapses before headers arrive
 *   and `afterResponse` settles.
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
  const { reqEvent, fetchInit, start, timeoutId, timeoutSignal, timeoutMs, callController } = prepared

  try {
    // As in `request()`: only the fetch and reading an error body are the wire.
    let response: Response
    try {
      response = await globalThis.fetch(reqEvent.url, fetchInit)
    } catch (e) {
      if (timeoutId) clearTimeout(timeoutId)
      return await translateAndFireError(
        e,
        reqEvent,
        () => callOpts.hooks,
        timeoutSignal,
        timeoutMs,
        fetchInit.signal,
        trace,
        callController,
      )
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

    let hooks: RequestHooks | undefined
    try {
      // Read inside the try: a throwing `hooks` getter still releases the body.
      hooks = callOpts.hooks
      await runStreamAfterResponse(hooks, reqEvent, resEvent, fetchInit.signal, trace)
    } catch (e) {
      // The caller never gets this response: release its connection.
      response.body?.cancel().catch(() => {})
      if (!isAbort(e, fetchInit.signal)) {
        // The hook's own error reaches the caller unchanged; the call ends
        // here, and so does what the hook left running under req.signal.
        callController.abort(e)
        throw e
      }
      // The deadline or the caller's abort ended the wait — a TimeoutError
      // (onError fired) or the abort's reason, never a bare AbortError from a
      // body the timer already cut.
      if (timeoutId) clearTimeout(timeoutId)
      return await translateAndFireError(
        e,
        reqEvent,
        () => hooks,
        timeoutSignal,
        timeoutMs,
        fetchInit.signal,
        trace,
        callController,
      )
    }

    // For error responses we DO consume the body to map to a typed error —
    // the caller never gets a chance to read it. For success, the body is
    // left untouched and returned to the caller.
    if (response.status >= 400) {
      let body: string
      try {
        body = await response.text()
        // The exchange with 1С is over: the timer stops here, as on a buffered call.
        if (timeoutId) clearTimeout(timeoutId)
      } catch (e) {
        if (timeoutId) clearTimeout(timeoutId)
        return await translateAndFireError(
          e,
          reqEvent,
          () => callOpts.hooks,
          timeoutSignal,
          timeoutMs,
          fetchInit.signal,
          trace,
          callController,
        )
      }
      const err = await mapResponseToError(response.status, response.statusText, headers, body, {
        method: reqEvent.method,
        url: reqEvent.url,
      })
      await endOnHookError(
        runHook(() => hooks?.onError?.(reqEvent, err), trace, err),
        callController,
        err,
      )
      throw err
    }

    return { response, durationMs }
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}
