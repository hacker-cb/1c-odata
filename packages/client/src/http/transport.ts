import type { RequestOptions } from '../client/options.js'
import { NetworkError, ODataError, TimeoutError } from '../errors.js'
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
 */
async function prepareRequest(
  config: RequestConfig,
  callOpts: TransportOptions & RequestOptions,
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
  if (callOpts.hooks?.beforeRequest) {
    const result = await callOpts.hooks.beforeRequest(reqEvent)
    if (result) reqEvent = result
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
  if (e instanceof Error && e.name === 'AbortError') {
    if (timeoutSignal?.signal.aborted) {
      const err = new TimeoutError(`Request timed out after ${timeoutMs!}ms`, { timeoutMs: timeoutMs!, cause: e })
      if (hooks?.onError) await hooks.onError(reqEvent, err)
      throw err
    }
    // Pass through user-issued abort: rethrow original
    throw e
  }
  if (e instanceof ODataError) throw e
  // Anything else is treated as network-level
  const err = new NetworkError(`Network error: ${(e as Error).message ?? 'unknown'}`, { cause: e })
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
 * @throws {ParseError} when the error response body is unparseable (invalid
 *   JSON, unrecognised content-type) — the original status is lost.
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
      const err = await mapResponseToError(response.status, response.statusText, headers, body)
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
 * @throws {ParseError} when the error response body is unparseable.
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
      const err = await mapResponseToError(response.status, response.statusText, headers, body)
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
