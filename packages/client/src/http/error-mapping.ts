import {
  BusinessError,
  ConcurrencyError,
  HTTPError,
  type ODataError,
  type ODataErrorBody,
  ParseError,
  PermissionError,
  type RequestContext,
} from '../errors.js'

/**
 * Map an HTTP error response to a typed `ODataError` subclass.
 * Decision tree (when a JSON/XML OData envelope is present):
 *   500 + odata.code "-1"       → BusinessError
 *   401                         → PermissionError (regardless of code; "20" is typical)
 *   412                         → ConcurrencyError
 *   400/404/405/406/411/501/etc → HTTPError (generic)
 * When the body is NOT a recognizable OData envelope (HTML/XHTML/proxy error
 * page, wrong path, over-long URL) → HTTPError with `errorFormat: 'none'`, the
 * real status preserved, no category subclass, and a truncated `rawBody`
 * snippet; IIS's own `400 Invalid URL` page gets a message naming its
 * per-segment length limit. A body that CLAIMS JSON but fails to parse / lacks the `odata.error`
 * wrapper → ParseError (a genuine parse failure, distinct from "no envelope").
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
  request: RequestContext,
): Promise<ODataError> {
  const ct = headers['content-type'] ?? ''
  let parsed: ODataErrorBody
  let format: 'json' | 'xml'

  if (ct.includes('application/json') || ct.includes('json')) {
    let obj: { 'odata.error'?: { code?: unknown; message?: unknown } }
    try {
      obj = JSON.parse(body)
    } catch (e) {
      return new ParseError(`Invalid JSON in error body (status ${status})`, { cause: e, request })
    }
    const err = obj['odata.error']
    if (!err) return new ParseError(`Response missing odata.error wrapper (status ${status})`, { request })
    // Tolerate envelope-shape drift: a present-but-odd `odata.error` still yields
    // a usable HTTPError instead of a misleading "Invalid JSON" ParseError.
    parsed = { code: String(err.code ?? ''), message: extractODataMessage(err.message) }
    format = 'json'
  } else if (ct.includes('xml')) {
    // Only a real `<m:error>` envelope counts as XML. An XHTML/proxy error page
    // served with an `xml` content-type but no `<code>`/`<message>` is treated
    // as no-envelope (same as HTML) rather than a fabricated category error.
    const xmlBody = parseXmlError(body)
    if (!xmlBody) return noEnvelopeError(status, statusText, ct, body, request)
    parsed = xmlBody
    format = 'xml'
  } else {
    return noEnvelopeError(status, statusText, ct, body, request)
  }

  // Status-based dispatch (a real OData envelope is present)
  const message = `HTTP ${status} ${statusText}: ${parsed.message}`
  const opts = { status, statusText, code: parsed.code, errorFormat: format, odata: parsed, request }
  if (status === 500 && parsed.code === '-1') return new BusinessError(message, opts)
  if (status === 401) return new PermissionError(message, opts)
  if (status === 412) return new ConcurrencyError(message, opts)
  return new HTTPError(message, opts)
}

/**
 * Build the `errorFormat: 'none'` HTTPError for a non-2xx whose body is not a
 * recognizable OData envelope (HTML/XHTML/proxy page, wrong path, over-long
 * URL). The real status survives; a short preview goes inline in the message
 * and the full truncated body travels in `rawBody`.
 */
function noEnvelopeError(
  status: number,
  statusText: string,
  ct: string,
  body: string,
  request: RequestContext,
): HTTPError {
  const rawBody = truncateRaw(body, 512)
  const preview = truncateRaw(body, 160)
  const message =
    iisInvalidUrlMessage(status, statusText, body, request.url) ??
    `HTTP ${status} ${statusText}: server returned no OData error envelope ` +
      `(content-type "${ct || 'none'}"). Check the request URL — a wrong ` +
      `entity-set path, a missing base, or an over-long URL (1С rejects requests ` +
      `past its URL-length limit) typically produces this instead of a JSON ` +
      `odata.error envelope.${preview ? ` Body starts: ${preview}` : ''}`
  return new HTTPError(message, {
    status,
    statusText,
    errorFormat: 'none',
    request,
    ...(rawBody ? { rawBody } : {}),
  })
}

/**
 * IIS (http.sys) caps each URL path segment at 260 characters by default
 * (`UrlSegmentMaxLength`), counted on the DECODED path — an encoded `%2F`
 * splits segments too (measured on a 1С base behind IIS).
 */
const IIS_URL_SEGMENT_MAX = 260

/**
 * The message for http.sys's own `400 Bad Request — Invalid URL` page, or
 * `null` when the response is not that page. The usual trigger against 1С is a
 * register virtual table called with its parameters in the path —
 * `…/Turnovers(StartPeriod=…,AccountCondition='…')` puts them all in ONE
 * segment, so a condition of about two GUIDs already passes the cap — while
 * `client.register(…)` / MCP `register_query` send them in the query string,
 * which has no such limit.
 */
function iisInvalidUrlMessage(status: number, statusText: string, body: string, url: string): string | null {
  if (status !== 400 || !/Invalid URL/i.test(body)) return null
  const head = `HTTP ${status} ${statusText}: IIS rejected the request URL as invalid ("Invalid URL")`
  const longest = longestPathSegment(url)
  if (longest > IIS_URL_SEGMENT_MAX) {
    return (
      `${head} — a path segment is ${longest} characters, over IIS's ${IIS_URL_SEGMENT_MAX}-character ` +
      'limit per segment (http.sys UrlSegmentMaxLength). Register virtual-table parameters written in the ' +
      "path — …/Turnovers(StartPeriod=…,AccountCondition='…') — all sit in one segment: call the table through " +
      'client.register(…) or the MCP register_query tool, which pass them in the query string with no such ' +
      'limit, or split the condition across several calls.'
    )
  }
  return `${head} — check the path for characters or lengths the web server refuses (IIS caps each path segment at ${IIS_URL_SEGMENT_MAX} characters).`
}

/** Length of the longest segment of a URL's decoded path; 0 when the URL does not parse. */
function longestPathSegment(url: string): number {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    return 0
  }
  try {
    path = decodeURIComponent(path)
  } catch {
    // Malformed escapes: measure the raw path — an overestimate is still the hint's answer.
  }
  return Math.max(0, ...path.split('/').map((seg) => seg.length))
}

/**
 * Pull the human message out of an `odata.error.message`, tolerating shape
 * drift: the 1С envelope nests it as `{ value }`, but some servers send a bare
 * string. Never throws — an unrecognized shape yields a generic fallback.
 */
function extractODataMessage(m: unknown): string {
  if (typeof m === 'string') return m
  if (typeof m === 'object' && m !== null && typeof (m as { value?: unknown }).value === 'string') {
    return (m as { value: string }).value
  }
  return 'Unknown OData error'
}

/**
 * Parse the narrow OData/$batch `<error><code/><message/></error>` envelope.
 * Returns `null` when neither `<code>` nor `<message>` is present — i.e. the
 * body is not an OData XML error (e.g. an XHTML/proxy error page), so the caller
 * routes it through the no-envelope path instead of fabricating a code.
 */
function parseXmlError(xml: string): ODataErrorBody | null {
  const codeMatch = xml.match(/<code>(.*?)<\/code>/)
  const messageMatch = xml.match(/<message[^>]*>(.*?)<\/message>/s)
  if (!codeMatch && !messageMatch) return null
  return {
    code: codeMatch?.[1] ?? '0',
    message: messageMatch?.[1] ?? 'Unknown XML error',
  }
}

/** Trim + cap a raw response body for use as a diagnostic snippet. */
function truncateRaw(s: string, max: number): string {
  const t = s.trim()
  if (t.length <= max) return t
  return `${t.slice(0, max)}… (${t.length - max} more chars)`
}
