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
  // Media types are case-insensitive (RFC 9110 §8.3.1).
  const mediaType = ct.toLowerCase()
  let parsed: ODataErrorBody
  let format: 'json' | 'xml'

  if (mediaType.includes('json')) {
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
  } else if (mediaType.includes('xml')) {
    // Only a real `<m:error>` envelope counts as XML. An XHTML/proxy error page
    // served with an `xml` content-type — even one with a `<code>` element in
    // its markup — is treated as no-envelope (same as HTML) rather than a
    // fabricated category error.
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
  const message = iisInvalidUrlMessage(status, statusText, ct, body, request.url) ?? genericMessage()
  function genericMessage(): string {
    const preview = truncateRaw(body, 160)
    return (
      `HTTP ${status} ${statusText}: server returned no OData error envelope ` +
      `(content-type "${ct || 'none'}"). Check the request URL — a wrong ` +
      `entity-set path, a missing base, or an over-long URL (1С rejects requests ` +
      `past its URL-length limit) typically produces this instead of a JSON ` +
      `odata.error envelope.${preview ? ` Body starts: ${preview}` : ''}`
    )
  }
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
 * (`UrlSegmentMaxLength`; a server may configure another value), counted on
 * the DECODED path — an encoded `%2F` splits segments too (measured on a 1С
 * base behind IIS).
 */
const IIS_URL_SEGMENT_MAX = 260

/** http.sys's own error page for a URL it refuses — its title line and its body sentence. */
const IIS_INVALID_URL_PAGE = /Bad Request - Invalid URL|The request URL is invalid/i

/**
 * The message for http.sys's own `400 Bad Request — Invalid URL` HTML page, or
 * `null` when the response is not that page. The usual trigger against 1С is a
 * register virtual table called with its parameters in the path —
 * `…/Turnovers(StartPeriod=…,AccountCondition='…')` puts them all in ONE
 * segment, so a condition of about two GUIDs already passes the default cap —
 * while `client.register(…)` (MCP: `register_query`) sends them in the query
 * string, which has no such limit.
 */
function iisInvalidUrlMessage(
  status: number,
  statusText: string,
  ct: string,
  body: string,
  url: string,
): string | null {
  if (status !== 400 || !ct.toLowerCase().includes('html') || !IIS_INVALID_URL_PAGE.test(body)) return null
  const head = `HTTP ${status} ${statusText}: IIS rejected the request URL as invalid ("Invalid URL")`
  const longest = longestPathSegment(url)
  if (longest > IIS_URL_SEGMENT_MAX) {
    return (
      `${head} — a path segment is ${longest} characters, over IIS's default ${IIS_URL_SEGMENT_MAX}-character ` +
      'limit per segment (http.sys UrlSegmentMaxLength). Register virtual-table parameters written in the ' +
      "path — …/Turnovers(StartPeriod=…,AccountCondition='…') — all sit in one segment: call the table through " +
      'client.register(…) (in the MCP server: register_query), which passes them in the query string with no ' +
      'such limit, or split the condition into calls over disjoint subsets (e.g. one account each).'
    )
  }
  return (
    `${head} — check the path for characters or lengths the web server refuses ` +
    `(IIS caps each path segment at ${IIS_URL_SEGMENT_MAX} characters by default).`
  )
}

/**
 * Length of the longest segment of a URL's path, measured as IIS does: on the
 * decoded text, an encoded `/` splitting too. In a segment whose escapes do not
 * all decode, each run of escapes is decoded on its own. 0 when the URL does not parse.
 */
function longestPathSegment(url: string): number {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    return 0
  }
  let longest = 0
  for (const raw of path.split('/')) {
    let decoded: string
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      // Decode each run of escapes on its own, so one bad escape leaves the rest
      // (multi-byte letters, an encoded `/`) read as IIS reads them.
      decoded = raw.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
        try {
          return decodeURIComponent(run)
        } catch {
          return '_'
        }
      })
    }
    for (const seg of decoded.split('/')) if (seg.length > longest) longest = seg.length
  }
  return longest
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

/** The namespace an OData V3 error envelope's elements live in. */
const ODATA_METADATA_NS = 'http://schemas.microsoft.com/ado/2007/08/dataservices/metadata'

/**
 * Parse the OData error envelope: a root `error` element in the OData
 * metadata namespace, its `code` and `message` read from its direct children
 * in that namespace. 1С sends it prefixed —
 * `<m:error xmlns:m="…/dataservices/metadata"><m:code>9</m:code><m:message>…</m:message></m:error>`
 * — and the unprefixed form under a default namespace is the same envelope.
 * Returns `null` for anything else — an XHTML/proxy error page, whatever
 * `<code>` or `<message>` its markup holds, or an envelope with neither field
 * — so the caller routes it through the no-envelope path instead of
 * fabricating a code.
 *
 * A small linear scanner, not a full XML parser (the client carries no
 * dependencies): it skips the prolog, reads attributes with their quoting,
 * resolves namespace prefixes by scope, skips comments and processing
 * instructions, takes CDATA as text and decodes the predefined and numeric
 * entities. Every step advances through the body, so no input costs more
 * than one pass over it.
 */
function parseXmlError(xml: string): ODataErrorBody | null {
  let i = skipXmlProlog(xml)
  if (i < 0 || xml[i] !== '<') return null
  const root = readStartTag(xml, i)
  if (root === null || root.selfClosing) return null
  const scopes = [namespaceDecls(root.attrs)]
  if (!isODataElement(root.name, scopes, 'error')) return null

  const found: { code?: string; message?: string } = {}
  let capture: { field: 'code' | 'message'; parts: string[] } | null = null
  let depth = 0 // elements open inside the root
  i = root.end
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) break
    if (capture !== null && lt > i) capture.parts.push(decodeXmlText(xml.slice(i, lt)))
    if (xml.startsWith('<!--', lt) || xml.startsWith('<?', lt)) {
      const close = xml.startsWith('<!--', lt) ? '-->' : '?>'
      const e = xml.indexOf(close, lt + 2)
      if (e < 0) break
      i = e + close.length
      continue
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9)
      if (e < 0) break
      capture?.parts.push(xml.slice(lt + 9, e))
      i = e + 3
      continue
    }
    if (xml.startsWith('</', lt)) {
      const e = xml.indexOf('>', lt + 2)
      if (e < 0 || depth === 0) break // the root closed (or the body ends)
      i = e + 1
      scopes.pop()
      depth--
      if (depth === 0 && capture !== null) {
        found[capture.field] ??= capture.parts.join('')
        capture = null
      }
      continue
    }
    const tag = readStartTag(xml, lt)
    if (tag === null) break
    i = tag.end
    if (tag.selfClosing && depth > 0) continue
    scopes.push(namespaceDecls(tag.attrs))
    if (depth === 0) {
      const field = isODataElement(tag.name, scopes, 'code')
        ? 'code'
        : isODataElement(tag.name, scopes, 'message')
          ? 'message'
          : undefined
      if (tag.selfClosing) {
        if (field !== undefined) found[field] ??= ''
        scopes.pop()
        continue
      }
      if (field !== undefined && found[field] === undefined) capture = { field, parts: [] }
    }
    depth++
  }
  if (found.code === undefined && found.message === undefined) return null
  return { code: found.code?.trim() ?? '0', message: found.message ?? 'Unknown XML error' }
}

/**
 * Index of the root element's `<`, past an optional BOM, the XML declaration,
 * comments, processing instructions, a doctype (internal subset included) and
 * whitespace; -1 where the prolog does not close.
 */
function skipXmlProlog(xml: string): number {
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0
  for (;;) {
    i = skipXmlSpace(xml, i)
    if (xml.startsWith('<?', i) || xml.startsWith('<!--', i)) {
      const close = xml.startsWith('<?', i) ? '?>' : '-->'
      const e = xml.indexOf(close, i + 2)
      if (e < 0) return -1
      i = e + close.length
    } else if (xml.startsWith('<!DOCTYPE', i)) {
      i = skipDoctype(xml, i + 9)
      if (i < 0) return -1
    } else {
      return i
    }
  }
}

/** Index past a doctype's closing `>`, its quoted literals and `[…]` internal subset skipped whole; -1 if unclosed. */
function skipDoctype(xml: string, from: number): number {
  let quote = ''
  let subset = false
  for (let j = from; j < xml.length; j++) {
    const c = xml[j]
    if (quote !== '') {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") quote = c
    else if (c === '[') subset = true
    else if (c === ']') subset = false
    else if (c === '>' && !subset) return j + 1
  }
  return -1
}

interface XmlStartTag {
  name: string
  attrs: Map<string, string>
  selfClosing: boolean
  /** Index just past the tag's `>`. */
  end: number
}

/** Read the start tag whose `<` is at `lt` — its name and attributes, values unquoted and decoded; `null` if malformed. */
function readStartTag(xml: string, lt: number): XmlStartTag | null {
  let j = readXmlName(xml, lt + 1)
  const name = xml.slice(lt + 1, j)
  if (name === '') return null
  const attrs = new Map<string, string>()
  for (;;) {
    j = skipXmlSpace(xml, j)
    if (xml.startsWith('/>', j)) return { name, attrs, selfClosing: true, end: j + 2 }
    if (xml[j] === '>') return { name, attrs, selfClosing: false, end: j + 1 }
    const k = readXmlName(xml, j)
    if (k === j) return null
    const attr = xml.slice(j, k)
    j = skipXmlSpace(xml, k)
    if (xml[j] !== '=') return null
    j = skipXmlSpace(xml, j + 1)
    const quote = xml[j]
    if (quote !== '"' && quote !== "'") return null
    const e = xml.indexOf(quote, j + 1)
    if (e < 0) return null
    attrs.set(attr, decodeXmlText(xml.slice(j + 1, e)))
    j = e + 1
  }
}

/** Index past the XML name starting at `i` (stops at whitespace, `/`, `>`, `=`, `<`, quotes). */
function readXmlName(xml: string, i: number): number {
  let j = i
  while (j < xml.length && !/[\s/>=<"']/.test(xml[j] as string)) j++
  return j
}

function skipXmlSpace(xml: string, i: number): number {
  let j = i
  while (j < xml.length && /\s/.test(xml[j] as string)) j++
  return j
}

/** The namespace declarations among a tag's attributes: prefix (`''` for the default) → URI. */
function namespaceDecls(attrs: Map<string, string>): Map<string, string> {
  const decls = new Map<string, string>()
  for (const [name, value] of attrs) {
    if (name === 'xmlns') decls.set('', value)
    else if (name.startsWith('xmlns:')) decls.set(name.slice(6), value)
  }
  return decls
}

/** Whether the element `qname`, under the namespace `scopes` (innermost last), is `local` in the OData metadata namespace. */
function isODataElement(qname: string, scopes: Map<string, string>[], local: string): boolean {
  const colon = qname.indexOf(':')
  const prefix = colon < 0 ? '' : qname.slice(0, colon)
  if ((colon < 0 ? qname : qname.slice(colon + 1)) !== local) return false
  for (let s = scopes.length - 1; s >= 0; s--) {
    const uri = scopes[s]?.get(prefix)
    if (uri !== undefined) return uri === ODATA_METADATA_NS
  }
  return false
}

const XML_NAMED_ENTITIES: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

/** Decode the predefined and numeric character references; an unknown or out-of-range one is left as written. */
function decodeXmlText(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|(lt|gt|amp|quot|apos));/g, (ref, hex, dec, named) => {
    if (named !== undefined) return XML_NAMED_ENTITIES[named] ?? ref
    const cp = Number.parseInt(hex ?? dec, hex !== undefined ? 16 : 10)
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : ref
  })
}

/** Trim + cap a raw response body for use as a diagnostic snippet. */
function truncateRaw(s: string, max: number): string {
  const t = s.trim()
  if (t.length <= max) return t
  return `${t.slice(0, max)}… (${t.length - max} more chars)`
}
