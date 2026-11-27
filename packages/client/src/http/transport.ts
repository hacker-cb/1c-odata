import type { RequestOptions } from '../client/options.js'
import { NetworkError, type ODataError, type RequestContext, TimeoutError } from '../errors.js'
import type { RequestEvent, RequestHooks, ResponseEvent } from '../hooks/types.js'
import { mapResponseToError } from './error-mapping.js'
import { timerDelay } from './timer.js'

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

/**
 * What the transport sends and reports, read once from the event
 * `beforeRequest` left — the snapshot nothing after the hook reads past.
 * Hooks are still handed the event itself; the transport reads only this.
 */
interface WireRequest {
  method: RequestEvent['method']
  url: string
  /** The transport's own copy ({@link readHeaders}) — read by nothing but it. */
  headers: WireHeaders
  body?: string
}

/**
 * Headers as the snapshot holds them: a plain object of strings, or string
 * pairs where the hook gave `Headers` or pairs (`fromHeaders` tells which, so
 * a copy for a later hook takes the form it had). Anything else — `undefined`,
 * a value fetch will refuse — as given.
 */
type WireHeaders =
  | { kind: 'record'; record: Record<string, string> }
  | { kind: 'pairs'; pairs: [string, string][]; fromHeaders: boolean }
  | { kind: 'other'; value: unknown }

interface PreparedRequest {
  /** The event later hooks are handed — the one `beforeRequest` left, carrying the request signal. */
  reqEvent: RequestEvent
  wire: WireRequest
  fetchInit: RequestInit
  start: number
  timeoutId: ReturnType<typeof setTimeout> | undefined
  timeoutSignal: AbortController | undefined
  timeoutMs: number | undefined
  /** Ends the call early — aborted when a hook's own error ends it, timeout or not. */
  callController: AbortController
  /** The request signal: the caller's, the timeout's and `callController`'s combined. */
  signal: AbortSignal
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
  let timeoutMs: number | undefined
  // Read once. Only a positive number starts the timer: 0, a negative or NaN
  // disables it. One past what `setTimeout` keeps (Infinity included) is capped
  // at that limit rather than firing at once; the TimeoutError reports the cap.
  const timeout = callOpts.timeout
  if (timeout && timeout > 0) {
    timeoutMs = timerDelay(timeout)
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
  let fetchInit: RequestInit
  let wire: WireRequest
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
    // The event keeps the call's signal — later hooks are promised it — whether
    // the hook returned a replacement without one or dropped it from the event
    // it was given. Set first, so what its setter does to the event is sent.
    const tookSignal = takesSignal(reqEvent, combined)
    // The snapshot, read once and still inside: a throwing getter on the event
    // the hook returned is the hook's own error — the call ends below, its
    // timer cleared, never retried. Nothing after this reads the event's fields
    // for the transport: the fetch, the method the trace records and the
    // request an error reports are the snapshot's.
    wire = readWire(reqEvent)
    if (trace) trace.method = wire.method
    // An event refusing the signal — frozen, or a setter ignoring the write —
    // is replaced for the later hooks by a copy.
    if (!tookSignal) reqEvent = copyEvent(reqEvent, wire, combined)
    fetchInit = {
      method: wire.method,
      ...fetchHeaders(wire.headers),
      signal: combined,
      ...(wire.body !== undefined ? { body: wire.body } : {}),
    }
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
        askedRequest(reqEvent, config),
        () => callOpts.hooks,
        timeoutSignal,
        timeoutMs,
        combined,
        trace,
        callController,
      )
    }
    // The hook's own failure — thrown by it, or by the event it returned: the
    // call ends here, never retried, and so does what the hook left running
    // under req.signal — the hook's error its reason.
    if (trace) trace.threw = true
    callController.abort(e)
    throw e
  }

  return { reqEvent, wire, fetchInit, start, timeoutId, timeoutSignal, timeoutMs, callController, signal: combined }
}

/**
 * What the request was when the wait for `beforeRequest` ended — its method
 * and url as the hook left them so far, or, where reading them throws, as
 * asked. Its headers and body are left unread: nothing will be sent.
 */
function askedRequest(event: RequestEvent, config: RequestConfig): WireRequest {
  const asked = { method: config.method, url: config.url, headers: readHeaders(config.headers) }
  try {
    return { ...asked, method: event.method, url: event.url }
  } catch {
    return asked
  }
}

/**
 * Read the request off `event` once, in the order the transport always has:
 * `method`, `url`, `body`, then `headers` ({@link readHeaders}). What throws
 * here throws to the caller.
 */
function readWire(event: RequestEvent): WireRequest {
  const method = event.method
  const url = event.url
  const body = event.body
  const headers = readHeaders(event.headers)
  return body !== undefined ? { method, url, headers, body } : { method, url, headers }
}

/**
 * Read headers the way fetch would, into the snapshot's own copy: a plain
 * object key by key (own enumerable keys, each value read and made a string in
 * turn), `Headers` or pairs pair by pair — so a getter, or a value whose
 * conversion throws, does so here rather than inside the fetch. What throws
 * here throws to the caller.
 */
function readHeaders(headers: unknown): WireHeaders {
  if (typeof headers !== 'object' || headers === null) return { kind: 'other', value: headers }
  if (Symbol.iterator in headers) {
    const pairs = Array.from(headers as Iterable<Iterable<unknown>>, (item): [string, string] => {
      const pair = Array.from(item)
      if (pair.length !== 2) throw new TypeError('a header pair must have exactly two items')
      return [`${pair[0]}`, `${pair[1]}`]
    })
    return { kind: 'pairs', pairs, fromHeaders: headers instanceof Headers }
  }
  const record: Record<string, string> = {}
  const source = headers as Record<PropertyKey, unknown>
  for (const key of Reflect.ownKeys(source)) {
    if (!Object.getOwnPropertyDescriptor(source, key)?.enumerable) continue
    // A template literal, not String(): a Symbol throws, as it does in fetch.
    record[`${key as string}`] = `${source[key]}`
  }
  return { kind: 'record', record }
}

/** What fetch is handed: the snapshot's headers. */
function fetchHeaders(headers: WireHeaders): Pick<RequestInit, 'headers'> {
  if (headers.kind === 'record') return { headers: headers.record }
  if (headers.kind === 'pairs') return { headers: headers.pairs }
  return headers.value === undefined ? {} : { headers: headers.value as NonNullable<RequestInit['headers']> }
}

/** The snapshot's headers as an event's — a copy of their own, in the form the hook gave them. */
function eventHeaders(headers: WireHeaders): RequestEvent['headers'] {
  if (headers.kind === 'record') return { ...headers.record }
  if (headers.kind === 'other') return headers.value as RequestEvent['headers']
  const pairs = headers.pairs.map(([name, value]): [string, string] => [name, value])
  // Cast: `Headers` and pairs are no `Record`, but fetch takes them, and a
  // hook that gave them gets them back.
  return (headers.fromHeaders ? new Headers(pairs) : pairs) as unknown as RequestEvent['headers']
}

/** The request fields of the snapshot, as an event's — headers a copy of their own, so a hook changing them changes no other. */
function wireFields(wire: WireRequest): Omit<RequestEvent, 'signal'> {
  const fields = { method: wire.method, url: wire.url, headers: eventHeaders(wire.headers) }
  return wire.body !== undefined ? { ...fields, body: wire.body } : fields
}

/** The request fields every copy of an event takes from the snapshot. */
const WIRE_KEYS: ReadonlySet<PropertyKey> = new Set(['method', 'url', 'headers', 'body', 'signal'])

/**
 * Whether `event` carries `signal` — set in place where it lacks it, so the
 * event a hook returned stays the one later hooks see (its prototype and
 * identity intact), and the write read back: a frozen event, or a setter that
 * ignores the write, does not take it. What throws here throws to the caller.
 */
function takesSignal(event: RequestEvent, signal: AbortSignal): boolean {
  if (event.signal === signal) return true
  return Reflect.set(event, 'signal', signal) && event.signal === signal
}

/**
 * A copy of `event` for the later hooks, carrying `signal`: its own fields
 * other than the request's kept as they are defined — a getter or setter
 * copied, not called, and still run on `event` itself — and the request's
 * fields the snapshot's. What throws here throws to the caller.
 */
function copyEvent(event: RequestEvent, wire: WireRequest, signal: AbortSignal): RequestEvent {
  const copy = {}
  const own = Object.getOwnPropertyDescriptors(event)
  for (const key of Reflect.ownKeys(own)) {
    const d = own[key as keyof typeof own]
    if (d === undefined || !d.enumerable || WIRE_KEYS.has(key)) continue
    const field: PropertyDescriptor = 'value' in d ? { value: d.value, writable: true } : {}
    if (d.get) field.get = d.get.bind(event)
    if (d.set) field.set = d.set.bind(event)
    Object.defineProperty(copy, key, { ...field, enumerable: true, configurable: true })
  }
  return Object.assign(copy, wireFields(wire), { signal })
}

/**
 * `event` carrying `signal` again before a later hook, outside any hook's
 * error handling: what an earlier hook did to the event — dropped the signal,
 * froze it, a getter or setter that throws — never fails the call. Where it
 * will not take the signal, the hook gets a copy of it ({@link copyEvent}), or,
 * where even that throws, the snapshot's request alone.
 */
function keepSignal(event: RequestEvent, signal: AbortSignal, wire: WireRequest): RequestEvent {
  try {
    if (takesSignal(event, signal)) return event
  } catch {
    // Copied below.
  }
  try {
    return copyEvent(event, wire, signal)
  } catch {
    return { ...wireFields(wire), signal }
  }
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
 * Await a hook already started, and where it fails — with its own error —
 * abort the call's controller: the call ends with that error, and so does
 * what the hook left running under `req.signal`. Aborted only once the hook
 * has settled, so the abort never races the hook's error to the caller.
 */
async function endOnHookError<T>(hook: Promise<T>, call: AbortController): Promise<T> {
  try {
    return await hook
  } catch (e) {
    call.abort(e)
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
 *
 * The wait for `onError` is bounded by the request signal — what is left of
 * the timeout, and the caller's signal (`RequestHooks`, "How long the call
 * waits for a hook"): on a `TimeoutError` it is not waited for; on a
 * `NetworkError` the deadline keeps that error and a caller's abort gives its
 * reason.
 */
async function translateAndFireError(
  e: unknown,
  reqEvent: RequestEvent,
  wire: WireRequest,
  readHooks: () => RequestHooks | undefined,
  timeoutSignal: AbortController | undefined,
  timeoutMs: number | undefined,
  requestSignal: AbortSignal | null | undefined,
  trace: AttemptTrace | undefined,
  callController: AbortController,
): Promise<never> {
  // The snapshot's, never the event's: a getter on it is not read again here.
  const request: RequestContext = { method: wire.method, url: wire.url }
  // onError is promised the signal, whatever an earlier hook did to the event.
  const event = requestSignal ? keepSignal(reqEvent, requestSignal, wire) : reqEvent
  // The request signal carries the reason of whichever source aborted it
  // first: a timeout only where the timer was first.
  const timedOut = (): boolean =>
    timeoutSignal?.signal.aborted === true && requestSignal?.reason === timeoutSignal.signal.reason
  // timeoutMs is paired with timeoutSignal in prepareRequest: set whenever the signal can fire.
  if (timedOut() && timeoutMs !== undefined) {
    const err = new TimeoutError(`Request timed out after ${timeoutMs}ms`, {
      timeoutMs,
      cause: e,
      request,
    })
    // The deadline has passed: onError is told, not waited for.
    runHook(() => readHooks()?.onError?.(event, err), undefined, err).catch(() => {})
    throw err
  }
  // A caller's abort is no network failure and nothing to retry: the caller
  // gets back its own reason — an AbortError, or whatever it aborted with.
  if (requestSignal?.aborted) throw requestSignal.reason
  if (e instanceof Error && e.name === 'AbortError') throw e
  // Anything else failed on the wire: a network-level error
  const err = new NetworkError(networkErrorMessage(e), { cause: e, request })
  // By the deadline the call keeps its NetworkError, by the caller's abort it
  // gets the abort's reason.
  return await awaitOnError(
    () => readHooks()?.onError?.(event, err),
    err,
    requestSignal,
    callController,
    trace,
    () => (timedOut() ? err : requestSignal?.reason),
  )
}

/**
 * Run `onError` — handed `err` — and wait for it no longer than `signal`
 * allows, then fail the call. In time, the call fails with `err`, or with the
 * hook's own error (recorded in `trace`, and aborting the call's controller,
 * which ends what the hook left under `req.signal`); `err` rethrown is the
 * library's again. Cut by the signal, it fails with what `cut` gives — the
 * abort's reason by default — and the hook goes on by itself, its rejection
 * handled and its late error recorded nowhere, so it cannot stop a retry the
 * call's own error allows. A signal already aborted when the hook starts — a
 * caller's abort during a buffered `afterResponse`, which does not hear it —
 * cut no wait: the hook is called but not waited for, and the call fails with
 * `err`, the outcome of the exchange.
 */
async function awaitOnError(
  run: () => void | PromiseLike<void>,
  err: ODataError,
  signal: AbortSignal | null | undefined,
  call: AbortController,
  trace: AttemptTrace | undefined,
  cut: () => unknown = () => signal?.reason,
): Promise<never> {
  if (signal?.aborted) {
    runHook(run, undefined, err).catch(() => {})
    throw err
  }
  const own: AttemptTrace = { threw: false }
  try {
    await settleWithin(runHook(run, own, err), signal ?? undefined)
  } catch (x) {
    if (isAbort(x, signal)) throw cut()
    if (own.threw && trace !== undefined) trace.threw = true
    if (x !== err) call.abort(x)
    throw x
  }
  throw err
}

/**
 * Execute one HTTP request. Handles timeout, signal combine, hooks invocation,
 * and error mapping. NO retry — that's a layer above (`http/retry.ts`).
 *
 * @throws {TimeoutError} when `callOpts.timeout` elapses before the response
 *   is received — `beforeRequest` included; `onError` is then called but not
 *   awaited. `afterResponse` is not bounded by it: it runs once the body is
 *   read, and the response stands however long the hook takes.
 * @throws {NetworkError} as well when `onError` on a network failure outlasts
 *   what is left of the timeout — the error it was handed.
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
 * @throws whatever a hook throws in time, unchanged — not wrapped, not
 *   passed to `onError`, and so never retried. A hook whose wait ended early
 *   (`RequestHooks`, "How long the call waits for a hook") — `onError` on a
 *   timeout among them — has what it throws later dropped.
 */
export async function request(
  config: RequestConfig,
  callOpts: TransportOptions & RequestOptions,
  trace?: AttemptTrace,
): Promise<RawResponse> {
  const prepared = await prepareRequest(config, callOpts, trace)
  const { reqEvent, wire, fetchInit, start, timeoutId, timeoutSignal, timeoutMs, callController, signal } = prepared

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
      response = await globalThis.fetch(wire.url, fetchInit)
      body = await response.text()
      // The exchange with 1С is over: the timeout bounded it and stops here, so
      // it never aborts req.signal under afterResponse / onError below.
      if (timeoutId) clearTimeout(timeoutId)
    } catch (e) {
      // The timer runs on: it bounds onError's wait below (translateAndFireError).
      return await translateAndFireError(
        e,
        reqEvent,
        wire,
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
        method: wire.method,
        url: wire.url,
      })
      // Not bounded by the timeout — the exchange is over and the timer stopped
      // with the body read — but a caller's abort ends the wait.
      const event = keepSignal(reqEvent, signal, wire)
      return await awaitOnError(() => callOpts.hooks?.onError?.(event, err), err, signal, callController, trace)
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
 *   and `afterResponse` settles; `onError` is then called but not awaited.
 * @throws {NetworkError} on transport-level failure (DNS, connection reset,
 *   TLS handshake, etc.).
 * @throws {HTTPError} (and subclasses) when the server returns HTTP ≥ 400.
 *   Note: for the error path the body IS consumed in order to map to the
 *   typed error; the caller never sees the body in that case.
 * @throws {ParseError} when a JSON/XML error body is unparseable. A non-OData
 *   body yields an `HTTPError` with `errorFormat: 'none'` (status preserved).
 * @throws {DOMException} `AbortError` (`error.name === 'AbortError'`) is
 *   rethrown unchanged when the user-issued `AbortSignal` fires.
 * @throws whatever a hook throws in time, unchanged — not wrapped, not
 *   passed to `onError`; as for `request()`.
 */
export async function requestStream(
  config: RequestConfig,
  callOpts: TransportOptions & RequestOptions,
  trace?: AttemptTrace,
): Promise<StreamResponse> {
  const prepared = await prepareRequest(config, callOpts, trace)
  const { reqEvent, wire, fetchInit, start, timeoutId, timeoutSignal, timeoutMs, callController, signal } = prepared

  try {
    // As in `request()`: only the fetch and reading an error body are the wire.
    let response: Response
    try {
      response = await globalThis.fetch(wire.url, fetchInit)
    } catch (e) {
      // The timer runs on: it bounds onError's wait below (translateAndFireError).
      return await translateAndFireError(
        e,
        reqEvent,
        wire,
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
        wire,
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
        // The timer runs on: it bounds onError's wait below (translateAndFireError).
        return await translateAndFireError(
          e,
          reqEvent,
          wire,
          () => callOpts.hooks,
          timeoutSignal,
          timeoutMs,
          fetchInit.signal,
          trace,
          callController,
        )
      }
      const err = await mapResponseToError(response.status, response.statusText, headers, body, {
        method: wire.method,
        url: wire.url,
      })
      // As in request(): a caller's abort ends the wait, the timeout does not.
      const event = keepSignal(reqEvent, signal, wire)
      return await awaitOnError(() => hooks?.onError?.(event, err), err, signal, callController, trace)
    }

    return { response, durationMs }
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}
