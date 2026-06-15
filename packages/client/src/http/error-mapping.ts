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
 * snippet. A body that CLAIMS JSON but fails to parse / lacks the `odata.error`
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
    try {
      const obj = JSON.parse(body) as { 'odata.error'?: { code: string; message: { value: string } } }
      const err = obj['odata.error']
      if (!err) return new ParseError(`Response missing odata.error wrapper (status ${status})`, { request })
      parsed = { code: String(err.code), message: err.message.value }
      format = 'json'
    } catch (e) {
      return new ParseError(`Invalid JSON in error body (status ${status})`, { cause: e, request })
    }
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
    `HTTP ${status} ${statusText}: server returned no OData error envelope ` +
    `(content-type "${ct || 'none'}"). Check the request URL — a wrong ` +
    `entity-set path, a missing base, or an over-long URL (1С rejects requests ` +
    `past its URL-length limit) typically produces this instead of a JSON ` +
    `odata.error.${preview ? ` Body starts: ${preview}` : ''}`
  return new HTTPError(message, {
    status,
    statusText,
    errorFormat: 'none',
    request,
    ...(rawBody ? { rawBody } : {}),
  })
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
