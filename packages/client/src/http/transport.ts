import type { RequestOptions } from '../client/options.js'
import { NetworkError, ODataError, type RequestContext, TimeoutError } from '../errors.js'
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
 * The timeout covers the hook too: it starts first, the hook sees it in
 * `req.signal`, and a hook still pending when it fires fails the call with a
 * `TimeoutError` (`onError` fired) even where the hook ignores the signal. A
 * hook that throws before then fails the call with its own error, unchanged;
 * the timer is left to fire at its deadline, so work the hook started under
 * `req.signal` stays bounded by it.
 */
async function prepareRequest(
  config: RequestConfig,
  callOpts: TransportOptions & RequestOptions,
): Promise<PreparedRequest> {
  const start = Date.now()
  const beforeRequest = callOpts.hooks?.beforeRequest

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
    // A deadline, not work: whatever the request is waiting on (a socket, the
    // hook's own I/O) keeps the process alive; the timer alone never does, so
    // a path that leaves it pending cannot hold a short-lived process open.
    timeoutId.unref()
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
  if (beforeRequest) {
    try {
      const result = await withinDeadline(beforeRequest, reqEvent, timeoutSignal?.signal)
      if (result) reqEvent = result
    } catch (e) {
      // The deadline passed while the hook ran: a timeout, as on the wire.
      if (timeoutSignal?.signal.aborted && e instanceof Error && e.name === 'AbortError') {
        await translateAndFireError(e, reqEvent, callOpts.hooks, timeoutSignal, timeoutMs)
      }
      throw e
    }
  }

  const fetchInit: RequestInit = {
    method: reqEvent.method,
    headers: reqEvent.headers,
    ...(combined !== undefined ? { signal: combined } : {}),
    ...(reqEvent.body !== undefined ? { body: reqEvent.body } : {}),
  }

  return { reqEvent, fetchInit, start, timeoutId, timeoutSignal, timeoutMs }
}

/**
 * Run the `beforeRequest` hook, rejecting with the deadline's abort reason (an
 * `AbortError`) the moment `deadline` fires — whether or not the hook honours
 * `req.signal`. A hook outrun by the deadline is left to settle on its own; its
 * later rejection is nobody's to handle and is swallowed.
 */
async function withinDeadline(
  hook: NonNullable<RequestHooks['beforeRequest']>,
  reqEvent: RequestEvent,
  deadline: AbortSignal | undefined,
  // biome-ignore lint/suspicious/noConfusingVoidType: mirrors the hook's own return type.
): Promise<void | RequestEvent> {
  const pending = Promise.resolve().then(() => hook(reqEvent))
  if (!deadline) return pending
  pending.catch(() => {})
  let onAbort = (): void => {}
  const expired = new Promise<never>((_, reject) => {
    onAbort = () => reject(deadline.reason)
    if (deadline.aborted) onAbort()
    else deadline.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([pending, expired])
  } finally {
    deadline.removeEventListener('abort', onAbort)
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
 * Translate caught exceptions into the typed error hierarchy and fire the
 * `onError` hook. Shared between text and stream paths.
 */
async function translateAndFireError(
  e: unknown,
  reqEvent: RequestEvent,
  hooks: RequestHooks | undefined,
  timeoutSignal: AbortController | undefined,
  timeoutMs: number | undefined,
): Promise<never> {
  const request: RequestContext = { method: reqEvent.method, url: reqEvent.url }
  if (e instanceof Error && e.name === 'AbortError') {
    // timeoutMs is paired with timeoutSignal in prepareRequest: set whenever the signal can fire.
    if (timeoutSignal?.signal.aborted && timeoutMs !== undefined) {
      const err = new TimeoutError(`Request timed out after ${timeoutMs}ms`, {
        timeoutMs,
        cause: e,
        request,
      })
      if (hooks?.onError) await hooks.onError(reqEvent, err)
      throw err
    }
    // Pass through user-issued abort: rethrow original
    throw e
  }
  if (e instanceof ODataError) throw e
  // Anything else is treated as network-level
  const err = new NetworkError(networkErrorMessage(e), { cause: e, request })
  if (hooks?.onError) await hooks.onError(reqEvent, err)
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
 */
export async function request(
  config: RequestConfig,
  callOpts: TransportOptions & RequestOptions,
): Promise<RawResponse> {
  const prepared = await prepareRequest(config, callOpts)
  const { reqEvent, fetchInit, start, timeoutId, timeoutSignal, timeoutMs } = prepared

  try {
    // Use globalThis.fetch so MSW can intercept in tests.
    // Node 22+ globalThis.fetch is undici-based; transport-level options
    // (TLS/proxy) are configured process-wide via env vars / CLI flags,
    // not per-request.
    const response = await globalThis.fetch(reqEvent.url, fetchInit)

    const body = await response.text()
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

    if (callOpts.hooks?.afterResponse) await callOpts.hooks.afterResponse(reqEvent, resEvent)

    if (response.status >= 400) {
      const err = await mapResponseToError(response.status, response.statusText, headers, body, {
        method: reqEvent.method,
        url: reqEvent.url,
      })
      if (callOpts.hooks?.onError) await callOpts.hooks.onError(reqEvent, err)
      throw err
    }

    return { status: response.status, statusText: response.statusText, headers, body, durationMs }
  } catch (e) {
    if (timeoutId) clearTimeout(timeoutId)
    await translateAndFireError(e, reqEvent, callOpts.hooks, timeoutSignal, timeoutMs)
    throw e // unreachable — translateAndFireError always throws
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
 */
export async function requestStream(
  config: RequestConfig,
  callOpts: TransportOptions & RequestOptions,
): Promise<StreamResponse> {
  const prepared = await prepareRequest(config, callOpts)
  const { reqEvent, fetchInit, start, timeoutId, timeoutSignal, timeoutMs } = prepared

  try {
    const response = await globalThis.fetch(reqEvent.url, fetchInit)

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

    if (callOpts.hooks?.afterResponse) await callOpts.hooks.afterResponse(reqEvent, resEvent)

    // For error responses we DO consume the body to map to a typed error —
    // the caller never gets a chance to read it. For success, the body is
    // left untouched and returned to the caller.
    if (response.status >= 400) {
      const body = await response.text()
      const err = await mapResponseToError(response.status, response.statusText, headers, body, {
        method: reqEvent.method,
        url: reqEvent.url,
      })
      if (callOpts.hooks?.onError) await callOpts.hooks.onError(reqEvent, err)
      throw err
    }

    return { response, durationMs }
  } catch (e) {
    if (timeoutId) clearTimeout(timeoutId)
    await translateAndFireError(e, reqEvent, callOpts.hooks, timeoutSignal, timeoutMs)
    throw e // unreachable
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}
