import {
  BusinessError,
  ConcurrencyError,
  HTTPError,
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
 */
export async function mapResponseToError(
  status: number,
  statusText: string,
  headers: Record<string, string>,
  body: string,
): Promise<ODataError> {
  const ct = headers['content-type'] ?? ''
  let parsed: ODataErrorBody
  let format: 'json' | 'xml'

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
    return new ParseError(`Unrecognized error content-type "${ct}" (status ${status})`)
  }

  // Status-based dispatch
  const message = `HTTP ${status} ${statusText}: ${parsed.message}`
  const opts = { status, statusText, code: parsed.code, errorFormat: format, body: parsed }
  if (status === 500 && parsed.code === '-1') return new BusinessError(message, opts)
  if (status === 401) return new PermissionError(message, opts)
  if (status === 412) return new ConcurrencyError(message, opts)
  return new HTTPError(message, opts)
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
