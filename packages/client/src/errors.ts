/**
 * Error contract conventions used by `@1c-odata/client`:
 * - All errors extend `ODataError`. Catch broadly with `instanceof ODataError`,
 *   narrow with `instanceof <Subclass>`.
 * - Constructors take `(message: string, options?: XOptions)` where `XOptions`
 *   extends `ODataErrorOptions` (`{ cause?: unknown }`). `cause` is forwarded
 *   to the underlying `Error` via the ES2022 `Error.cause` chain.
 * - Messages are sentence-cased without a trailing period.
 * - Caller-side precondition violations throw `InvalidArgumentError` with
 *   structured `argument` and `received` fields when applicable.
 */

/**
 * Wire-level OData error body — common shape across JSON `odata.error` and XML
 * `<m:error>` responses. See spec §2.4 (errors) + §2.5.
 * @public
 */
export interface ODataErrorBody {
  /** 1C error code as string ("0".."21" or "-1" for business errors). */
  code: string
  /** Human-readable message, usually Russian. */
  message: string
}

/**
 * Format of the wire-level error body:
 * - `'json'` — `odata.error` envelope (default for 1С OData V3).
 * - `'xml'` — `<m:error>` (only for `$batch` and a few legacy endpoints).
 * - `'none'` — the server returned a non-2xx with no recognizable OData error
 *   envelope (wrong entity-set path, over-long URL, HTML/proxy error page).
 *   `HTTPError.code`/`.odata` are then `undefined`; `.rawBody` holds a
 *   truncated snippet of the raw response.
 * @public
 */
export type ErrorFormat = 'json' | 'xml' | 'none'

/**
 * Minimal descriptor of the HTTP request that produced an error. Attached to
 * errors that originate from a request (`HTTPError`, `NetworkError`,
 * `TimeoutError`). Carries only `method` + `url` — never headers — so logging
 * an error can never leak the `Authorization` header. Absent on errors not tied
 * to a request (`InvalidArgumentError`, `ValidationError`, file-load
 * `MetadataError`).
 * @public
 */
export interface RequestContext {
  method: string
  url: string
}

/**
 * Common options accepted by every `ODataError` subclass.
 * @public
 */
export interface ODataErrorOptions {
  /** Underlying cause (per ES2022 `Error.cause`). */
  cause?: unknown
  /** Request that produced this error, when it originated from an HTTP call. */
  request?: RequestContext
}

/**
 * Base for all library-thrown errors. Always preferred over throwing raw Error
 * so consumers can catch `ODataError` for blanket handling.
 * @public
 */
export abstract class ODataError extends Error {
  override readonly name: string = 'ODataError'
  /** Request that produced this error; `undefined` for non-request errors. */
  readonly request: RequestContext | undefined
  constructor(message: string, options?: ODataErrorOptions) {
    super(message, options)
    this.request = options?.request
  }
}

/**
 * HTTP-level error: server returned non-2xx. Subclasses narrow by category.
 * @public
 */
export interface HTTPErrorOptions extends ODataErrorOptions {
  status: number
  statusText: string
  errorFormat: ErrorFormat
  /** 1С error code — present only when a real OData envelope was parsed. */
  code?: string
  /** Parsed OData error envelope — present only with `errorFormat` `'json'`/`'xml'`. */
  odata?: ODataErrorBody
  /** Truncated raw response text — set when the body was not an OData envelope. */
  rawBody?: string
}

export class HTTPError extends ODataError {
  override readonly name: string = 'HTTPError'
  readonly status: number
  readonly statusText: string
  readonly errorFormat: ErrorFormat
  readonly code: string | undefined
  readonly odata: ODataErrorBody | undefined
  readonly rawBody: string | undefined

  constructor(message: string, opts: HTTPErrorOptions) {
    super(message, opts)
    this.status = opts.status
    this.statusText = opts.statusText
    this.errorFormat = opts.errorFormat
    this.code = opts.code
    this.odata = opts.odata
    this.rawBody = opts.rawBody
  }
}

/**
 * 1C business error (HTTP 500 + odata.error.code "-1"): business handler
 * (`ПередЗаписью`, `ДатыЗапретаИзменения`), Post failed, etc. NEVER retried.
 * @public
 */
export class BusinessError extends HTTPError {
  override readonly name = 'BusinessError'
}

/**
 * Optimistic-concurrency failure. The 1С server silently ignores `If-Match`
 * regardless of value, so HTTP 412 is never produced server-side. The library
 * throws `ConcurrencyError` from the client-side guard activated by
 * `MutationOptions.expectVersion`: it does a GET and compares `DataVersion`
 * before issuing the mutation.
 * @public
 */
export class ConcurrencyError extends HTTPError {
  override readonly name = 'ConcurrencyError'
}

/**
 * Permission/authorization failure (HTTP 401, often with odata.error.code "20").
 * @public
 */
export class PermissionError extends HTTPError {
  override readonly name = 'PermissionError'
}

/**
 * Transport-level error before HTTP semantics applied: ECONNRESET, ENOTFOUND,
 * TLS handshake failure, etc.
 * @public
 */
export class NetworkError extends ODataError {
  override readonly name = 'NetworkError'
  constructor(message: string, opts?: ODataErrorOptions) {
    super(message, opts)
  }
}

/**
 * Client-side timeout fired (RequestOptions.timeout exceeded).
 * @public
 */
export interface TimeoutErrorOptions extends ODataErrorOptions {
  timeoutMs: number
}

export class TimeoutError extends ODataError {
  override readonly name = 'TimeoutError'
  readonly timeoutMs: number

  constructor(message: string, opts: TimeoutErrorOptions) {
    super(message, opts)
    this.timeoutMs = opts.timeoutMs
  }
}

/**
 * HTTP **response** body could not be parsed (invalid JSON / malformed XML in a
 * server reply). For failures loading or parsing schema metadata — a local
 * `__metadata.json` or an EDMX `$metadata` document — see `MetadataError`.
 * @public
 */
export class ParseError extends ODataError {
  override readonly name = 'ParseError'
  constructor(message: string, opts?: ODataErrorOptions) {
    super(message, opts)
  }
}

/**
 * Failure loading or parsing schema metadata: a local `__metadata.json`
 * (read / JSON / shape validation via `loadMetadataIndex` / `parseMetadataIndex`)
 * or an EDMX `$metadata` document (`parseEdmx`). Distinct from `ParseError`,
 * which is reserved for HTTP response-body parse failures.
 * @public
 */
export class MetadataError extends ODataError {
  override readonly name = 'MetadataError'
  constructor(message: string, opts?: ODataErrorOptions) {
    super(message, opts)
  }
}

/**
 * Caller-side input violation: argument failed a precondition check
 * (negative top, missing required option, malformed URL, etc.).
 *
 * `argument` and `received` are diagnostic — surface in messages when relevant.
 * @public
 */
export interface InvalidArgumentErrorOptions extends ODataErrorOptions {
  argument?: string
  received?: unknown
}

export class InvalidArgumentError extends ODataError {
  override readonly name = 'InvalidArgumentError'
  readonly argument: string | undefined
  readonly received: unknown

  constructor(message: string, opts?: InvalidArgumentErrorOptions) {
    super(message, opts)
    this.argument = opts?.argument
    this.received = opts?.received
  }
}
