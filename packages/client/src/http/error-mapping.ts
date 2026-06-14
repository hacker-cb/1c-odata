import {
  BusinessError,
  ConcurrencyError,
  type ErrorFormat,
  HTTPError,
  type HTTPErrorOptions,
  type ODataError,
  type ODataErrorBody,
  ParseError,
  PermissionError,
} from '../errors.js'

/**
 * Map an HTTP error response to a typed `ODataError` subclass.
 * Decision tree:
 *   500 + body.code "-1"        → BusinessError
 *   401                         → PermissionError (regardless of code; "20" is typical)
 *   412                         → ConcurrencyError
 *   400/404/405/406/411/501/etc → HTTPError (generic)
 *
 * Non-OData bodies (e.g. an IIS HTML error page, `content-type: text/html`)
 * still map to a status-dispatched `HTTPError` (`errorFormat: 'none'`) carrying
 * an actionable message — NOT an opaque `ParseError` — so callers can branch on
 * `.status` (e.g. 404/414) and a relayed message tells a human/LLM what to do.
 *
 * @internal — wired into `http/transport.ts`; not part of the public surface.
 * Consumers should catch the typed error thrown by `request()` / `requestStream()`
 * instead of calling this directly.
 */
export async function mapResponseToError(
  status: number,
  statusText: string,
  headers: Record<string, string>,
  body: string,
): Promise<ODataError> {
  const ct = headers['content-type'] ?? ''
  let parsed: ODataErrorBody
  let format: ErrorFormat

  if (ct.includes('application/json') || ct.includes('json')) {
    try {
      const obj = JSON.parse(body) as { 'odata.error'?: { code: string; message: { value: string } } }
      const err = obj['odata.error']
      if (!err) return new ParseError(`Response missing odata.error wrapper (status ${status})`)
      parsed = { code: String(err.code), message: err.message.value }
      format = 'json'
    } catch (e) {
      return new ParseError(`Invalid JSON in error body (status ${status})`, { cause: e })
    }
  } else if (ct.includes('xml')) {
    parsed = parseXmlError(body)
    format = 'xml'
  } else {
    // Not an OData error envelope (commonly an IIS HTML error page). The
    // canonical trigger is an over-long request URL: IIS rejects query strings
    // past `maxQueryString` (default 2048 bytes) with an HTML 404 — there is no
    // `odata.error` to parse. Surface an actionable, status-bearing HTTPError
    // instead of dropping the status into an opaque ParseError.
    return nonODataError(status, statusText, ct)
  }

  // Status-based dispatch
  const message = `HTTP ${status} ${statusText}: ${parsed.message}`
  const opts = { status, statusText, code: parsed.code, errorFormat: format, body: parsed }
  if (status === 500 && parsed.code === '-1') return new BusinessError(message, opts)
  return dispatchByStatus(status, message, opts)
}

/**
 * Map a status to the right `HTTPError` subclass: 401 → `PermissionError`,
 * 412 → `ConcurrencyError`, everything else → generic `HTTPError`. Shared by the
 * OData-envelope path and the non-OData path so a new status mapping is added
 * once. (The `500 + code "-1"` → `BusinessError` rule depends on the parsed
 * code, so it stays at the OData-envelope call site.)
 */
function dispatchByStatus(status: number, message: string, opts: HTTPErrorOptions): HTTPError {
  if (status === 401) return new PermissionError(message, opts)
  if (status === 412) return new ConcurrencyError(message, opts)
  return new HTTPError(message, opts)
}

/**
 * Build a status-dispatched `HTTPError` for a response whose body is not an
 * OData error envelope. Preserves `status` / `statusText` and the original
 * content-type, and appends a remedy hint tuned for the over-long-URL case
 * (404/414), the failure mode that motivated this path.
 */
function nonODataError(status: number, statusText: string, contentType: string): HTTPError {
  const ct = contentType || 'unknown'
  const hint =
    status === 404 || status === 414
      ? 'For 404/414 this often means a wrong entity-set path or an over-long request URL — reduce the $filter (fewer OR terms), trim $select/$expand, or lower the page size (e.g. batch large key lists with getByKeys()/whereIn()).'
      : 'The server did not return a parseable OData error body.'
  const where = statusText ? ` ${statusText}` : ''
  const message = `HTTP ${status}${where}: server returned a non-OData ${ct} body (not an OData error). ${hint}`
  const body: ODataErrorBody = { code: '0', message }
  const opts: HTTPErrorOptions = { status, statusText, code: '0', errorFormat: 'none', body }
  return dispatchByStatus(status, message, opts)
}

function parseXmlError(xml: string): ODataErrorBody {
  // Minimal XML parsing for `<error><code>...</code><message ...>...</message></error>`.
  // Not a full XML parser — sufficient for the narrow $batch-style error shape.
  const codeMatch = xml.match(/<code>(.*?)<\/code>/)
  const messageMatch = xml.match(/<message[^>]*>(.*?)<\/message>/s)
  return {
    code: codeMatch?.[1] ?? '0',
    message: messageMatch?.[1] ?? 'Unknown XML error',
  }
}
