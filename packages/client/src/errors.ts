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
 * Format of the wire-level error body — JSON `odata.error` (default) or XML
 * `<m:error>` (only for `$batch` and a few legacy endpoints).
 * @public
 */
export type ErrorFormat = 'json' | 'xml'

/**
 * Common options accepted by every `ODataError` subclass.
 * @public
 */
export interface ODataErrorOptions {
  /** Underlying cause (per ES2022 `Error.cause`). */
  cause?: unknown
}

/**
 * Base for all library-thrown errors. Always preferred over throwing raw Error
 * so consumers can catch `ODataError` for blanket handling.
 * @public
 */
export abstract class ODataError extends Error {
  override readonly name: string = 'ODataError'
  constructor(message: string, options?: ODataErrorOptions) {
    super(message, options)
  }
}

/**
 * HTTP-level error: server returned non-2xx. Subclasses narrow by category.
 * @public
 */
export interface HTTPErrorOptions extends ODataErrorOptions {
  status: number
  statusText: string
  code: string
  errorFormat: ErrorFormat
  body: ODataErrorBody
}

export class HTTPError extends ODataError {
  override readonly name: string = 'HTTPError'
  readonly status: number
  readonly statusText: string
  readonly code: string
  readonly errorFormat: ErrorFormat
  readonly body: ODataErrorBody

  constructor(message: string, opts: HTTPErrorOptions) {
    super(message, opts)
    this.status = opts.status
    this.statusText = opts.statusText
    this.code = opts.code
    this.errorFormat = opts.errorFormat
    this.body = opts.body
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
 * Response body could not be parsed (invalid JSON / malformed XML).
 * @public
 */
export class ParseError extends ODataError {
  override readonly name = 'ParseError'
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
