import { BusinessError, ConcurrencyError, HTTPError, ParseError, PermissionError } from '@1c-odata/client'
import { describe, expect, it } from 'vitest'
import { mapResponseToError } from '../../src/http/error-mapping.js'

const req = { method: 'GET', url: 'http://x/Catalog_X' }

describe('mapResponseToError', () => {
  it('maps HTTP 500 + code "-1" to BusinessError', async () => {
    const json = '{"odata.error":{"code":"-1","message":{"lang":"ru","value":"Не удалось провести \\"X\\""}}}'
    const err = await mapResponseToError(
      500,
      'Internal Server Error',
      { 'content-type': 'application/json' },
      json,
      req,
    )
    expect(err).toBeInstanceOf(BusinessError)
    expect((err as HTTPError).code).toBe('-1')
  })

  it('maps HTTP 401 + code "20" to PermissionError', async () => {
    const json = '{"odata.error":{"code":"20","message":{"lang":"ru","value":"Нарушение прав доступа"}}}'
    const err = await mapResponseToError(401, 'Unauthorized', { 'content-type': 'application/json' }, json, req)
    expect(err).toBeInstanceOf(PermissionError)
  })

  it('maps HTTP 412 to ConcurrencyError', async () => {
    const json = '{"odata.error":{"code":"0","message":{"lang":"ru","value":"Версия не совпадает"}}}'
    const err = await mapResponseToError(412, 'Precondition Failed', { 'content-type': 'application/json' }, json, req)
    expect(err).toBeInstanceOf(ConcurrencyError)
  })

  it('maps generic 4xx/5xx to HTTPError and carries request + odata', async () => {
    const json = '{"odata.error":{"code":"9","message":{"lang":"ru","value":"Экземпляр сущности не найден"}}}'
    const err = await mapResponseToError(404, 'Not Found', { 'content-type': 'application/json' }, json, req)
    expect(err).toBeInstanceOf(HTTPError)
    expect(err).not.toBeInstanceOf(BusinessError)
    expect((err as HTTPError).odata).toEqual({ code: '9', message: 'Экземпляр сущности не найден' })
    expect((err as HTTPError).request).toEqual(req)
  })

  it('parses XML m:error body for $batch-style endpoints', async () => {
    const xml = `<?xml version="1.0"?><error xmlns="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"><code>0</code><message xml:lang="ru">Произошла ошибка сервиса</message></error>`
    const err = await mapResponseToError(501, 'Not Implemented', { 'content-type': 'application/xml' }, xml, req)
    expect(err).toBeInstanceOf(HTTPError)
    expect((err as HTTPError).code).toBe('0')
    expect((err as HTTPError).errorFormat).toBe('xml')
    expect((err as HTTPError).request).toEqual(req)
  })

  it('returns HTTPError with errorFormat "none" when body is not an OData envelope', async () => {
    const err = await mapResponseToError(
      404,
      'Not Found',
      { 'content-type': 'text/html; charset=utf-8' },
      '<html>404 — not found</html>',
      req,
    )
    expect(err).toBeInstanceOf(HTTPError)
    expect(err).not.toBeInstanceOf(ParseError)
    expect((err as HTTPError).status).toBe(404)
    expect((err as HTTPError).errorFormat).toBe('none')
    expect((err as HTTPError).code).toBeUndefined()
    expect((err as HTTPError).odata).toBeUndefined()
    expect((err as HTTPError).rawBody).toContain('<html>')
    expect((err as HTTPError).request).toEqual(req)
    expect(err.message).toMatch(/no OData error envelope|URL/i)
  })

  it('routes an XML/XHTML body without an <m:error> envelope to errorFormat "none"', async () => {
    const err = await mapResponseToError(
      401,
      'Unauthorized',
      { 'content-type': 'text/xml; charset=utf-8' },
      '<html xmlns="http://www.w3.org/1999/xhtml"><body>401 Unauthorized (proxy)</body></html>',
      req,
    )
    expect(err).toBeInstanceOf(HTTPError)
    expect(err).not.toBeInstanceOf(PermissionError)
    expect((err as HTTPError).status).toBe(401)
    expect((err as HTTPError).errorFormat).toBe('none')
    expect((err as HTTPError).code).toBeUndefined()
    expect((err as HTTPError).odata).toBeUndefined()
  })

  describe('XML envelope recognition (#191)', () => {
    const xmlCt = { 'content-type': 'application/xml;charset=utf-8' }
    // As a 1С base serves it (trade 11.5, GET with an XML Accept) — docs 17.4.10 show the same shape.
    const onec = (code: string, message: string) =>
      '<m:error xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">\n' +
      `\t<m:code>${code}</m:code>\n\t<m:message>${message}</m:message>\n</m:error>`
    // A proxy / IIS page in XHTML with an HTML <code> element in its markup.
    const xhtml =
      '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Access denied</h1>' +
      '<p>Error <code>0x80070005</code></p><message>see the log</message></body></html>'

    it('recognises the prefixed <m:error> envelope 1С sends', async () => {
      const err = await mapResponseToError(404, 'Not found', xmlCt, onec('9', 'Экземпляр сущности не найден'), req)
      expect(err).toBeInstanceOf(HTTPError)
      expect((err as HTTPError).errorFormat).toBe('xml')
      expect((err as HTTPError).odata).toEqual({ code: '9', message: 'Экземпляр сущности не найден' })
    })

    it('maps the prefixed envelope to its category subclass', async () => {
      const denied = await mapResponseToError(401, 'Unauthorized', xmlCt, onec('20', 'Нарушение прав доступа'), req)
      expect(denied).toBeInstanceOf(PermissionError)
      const business = await mapResponseToError(500, 'Internal Server Error', xmlCt, onec('-1', 'Ошибка'), req)
      expect(business).toBeInstanceOf(BusinessError)
    })

    it('recognises the envelope past an XML declaration and a comment', async () => {
      const body = `<?xml version="1.0" encoding="utf-8"?>\n<!-- 1С -->\n${onec('6', 'Сегмент пути Nope не найден!')}`
      const err = await mapResponseToError(400, 'Bad request', xmlCt, body, req)
      expect((err as HTTPError).errorFormat).toBe('xml')
      expect((err as HTTPError).code).toBe('6')
    })

    for (const [status, statusText] of [
      [401, 'Unauthorized'],
      [403, 'Forbidden'],
    ] as const) {
      it(`routes an XHTML page with a <code> element on ${status} to errorFormat "none"`, async () => {
        const err = await mapResponseToError(
          status,
          statusText,
          { 'content-type': 'application/xhtml+xml; charset=utf-8' },
          xhtml,
          req,
        )
        expect(err).toBeInstanceOf(HTTPError)
        expect(err).not.toBeInstanceOf(PermissionError)
        expect((err as HTTPError).status).toBe(status)
        expect((err as HTTPError).errorFormat).toBe('none')
        expect((err as HTTPError).code).toBeUndefined()
        expect((err as HTTPError).rawBody).toContain('0x80070005')
      })
    }

    const NS = 'http://schemas.microsoft.com/ado/2007/08/dataservices/metadata'
    const fmt = async (status: number, body: string, ct = 'application/xml') =>
      (await mapResponseToError(status, 'X', { 'content-type': ct }, body, req)) as HTTPError

    it('scans hostile prologs in linear time', async () => {
      const comments = `${'<!--x-->'.repeat(5000)}${'<?x?>'.repeat(5000)}<html><body>no envelope</body></html>`
      const unclosed = `<!--${'-'.repeat(100_000)}`
      const started = performance.now()
      expect((await fmt(401, comments)).errorFormat).toBe('none')
      expect((await fmt(401, unclosed)).errorFormat).toBe('none')
      // Generous for a loaded runner: a backtracking scan of this input never finishes at all.
      expect(performance.now() - started).toBeLessThan(5_000)
    })

    it('decodes entities and CDATA in code and message', async () => {
      const err = await fmt(
        500,
        `<m:error xmlns:m="${NS}"><m:code>&#45;1</m:code><m:message>A &amp; B <![CDATA[<x>]]> &#x416;</m:message></m:error>`,
      )
      expect(err).toBeInstanceOf(BusinessError)
      expect(err.odata).toEqual({ code: '-1', message: 'A & B <x> Ж' })
    })

    it('reads only the direct children, skipping comments and nested elements', async () => {
      const err = await fmt(
        500,
        `<m:error xmlns:m="${NS}"><!-- <m:code>0</m:code> --><m:innererror><m:code>7</m:code></m:innererror>` +
          `<m:code >-1</m:code ><m:message>ok</m:message></m:error>`,
      )
      expect(err).toBeInstanceOf(BusinessError)
      expect(err.code).toBe('-1')
    })

    it('resolves child prefixes by namespace, not by spelling', async () => {
      const otherPrefix = await fmt(
        500,
        `<m:error xmlns:m="${NS}" xmlns:d="${NS}"><d:code>-1</d:code><d:message>x</d:message></m:error>`,
      )
      expect(otherPrefix).toBeInstanceOf(BusinessError)
      const rebound = await fmt(
        500,
        `<m:error xmlns:m="${NS}"><m:code xmlns:m="urn:other">-1</m:code><m:message>x</m:message></m:error>`,
      )
      expect(rebound).not.toBeInstanceOf(BusinessError)
      expect(rebound.code).toBe('0')
    })

    it('does not take a nested <m:error> past a comment for the root', async () => {
      const body = `<!-- a --><html xmlns="http://www.w3.org/1999/xhtml"><!-- b --><m:error xmlns:m="${NS}"><m:code>1</m:code></m:error></html>`
      const err = await fmt(401, body, 'application/xhtml+xml')
      expect(err).not.toBeInstanceOf(PermissionError)
      expect(err.errorFormat).toBe('none')
    })

    it('reads xmlns from attributes, not from text inside another attribute', async () => {
      const spoofed = `<m:error note='xmlns:m="${NS}"' xmlns:m="urn:proxy"><m:code>1</m:code></m:error>`
      expect((await fmt(401, spoofed)).errorFormat).toBe('none')
      const gt = `<m:error note="a > b" xmlns:m="${NS}"><m:code>9</m:code></m:error>`
      expect((await fmt(404, gt)).code).toBe('9')
    })

    it('requires a code or a message: a bare opening <m:error> is no envelope', async () => {
      const err = await fmt(401, `<m:error xmlns:m="${NS}">`)
      expect(err).not.toBeInstanceOf(PermissionError)
      expect(err.errorFormat).toBe('none')
    })

    it('recognises the envelope past a doctype with an internal subset', async () => {
      const body = `<?xml version="1.0"?><!DOCTYPE m:error [ <!ENTITY x "y>z"> ]><m:error xmlns:m="${NS}"><m:code>9</m:code></m:error>`
      expect((await fmt(404, body)).code).toBe('9')
    })

    it('requires a well-formed, closed envelope', async () => {
      const mismatched = `<m:error xmlns:m="${NS}"><m:code>-1</m:message></m:error>`
      const truncated = `<m:error xmlns:m="${NS}"><m:code>-1</m:code>`
      for (const body of [mismatched, truncated]) {
        const err = await fmt(500, body)
        expect(err).not.toBeInstanceOf(BusinessError)
        expect(err.errorFormat).toBe('none')
      }
    })

    it('takes a field from its own text, not from elements nested in it', async () => {
      const err = await fmt(500, `<m:error xmlns:m="${NS}"><m:code><detail>-1</detail></m:code></m:error>`)
      expect(err).not.toBeInstanceOf(BusinessError)
    })

    it('decodes numeric references with leading zeros, and leaves characters XML forbids as written', async () => {
      const err = await fmt(
        500,
        `<m:error xmlns:m="${NS}"><m:code>&#x0000002D;1</m:code><m:message>a&#0;b&#xD800;c</m:message></m:error>`,
      )
      expect(err).toBeInstanceOf(BusinessError)
      expect(err.odata?.message).toBe('a&#0;b&#xD800;c')
    })

    it('decides the format by the media type, not by its parameters', async () => {
      const err = await fmt(
        401,
        `<m:error xmlns:m="${NS}"><m:code>20</m:code></m:error>`,
        'application/xml; profile="urn:example:JSON"',
      )
      expect(err).toBeInstanceOf(PermissionError)
      expect(err.errorFormat).toBe('xml')
    })

    it('matches the content type case-insensitively', async () => {
      const err = await fmt(401, `<m:error xmlns:m="${NS}"><m:code>20</m:code></m:error>`, 'Application/XML')
      expect(err).toBeInstanceOf(PermissionError)
      const json = await fmt(404, '{"odata.error":{"code":"9","message":"x"}}', 'Application/JSON')
      expect(json.errorFormat).toBe('json')
    })

    it('rejects an <error> root outside the OData metadata namespace', async () => {
      const foreign = '<error xmlns="urn:example:proxy"><code>401</code><message>denied</message></error>'
      const unbound = '<error><code>401</code><message>denied</message></error>'
      const wrongPrefix =
        '<m:error xmlns:m="urn:example:proxy" xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">' +
        '<m:code>1</m:code></m:error>'
      for (const body of [foreign, unbound, wrongPrefix]) {
        const err = await mapResponseToError(401, 'Unauthorized', xmlCt, body, req)
        expect((err as HTTPError).errorFormat).toBe('none')
        expect(err).not.toBeInstanceOf(PermissionError)
      }
    })
  })

  it('keeps ParseError for a body that claims JSON but is malformed', async () => {
    const err = await mapResponseToError(400, 'Bad Request', { 'content-type': 'application/json' }, '{not json', req)
    expect(err).toBeInstanceOf(ParseError)
    expect(err.request).toEqual(req)
  })

  it('tolerates odata.error shape drift (bare string message) without a misleading ParseError', async () => {
    const json = '{"odata.error":{"code":"7","message":"plain string message"}}'
    const err = await mapResponseToError(400, 'Bad Request', { 'content-type': 'application/json' }, json, req)
    expect(err).toBeInstanceOf(HTTPError)
    expect(err).not.toBeInstanceOf(ParseError)
    expect((err as HTTPError).odata).toEqual({ code: '7', message: 'plain string message' })
  })

  it('falls back to a generic message when odata.error has no usable message', async () => {
    const json = '{"odata.error":{"code":"7"}}'
    const err = await mapResponseToError(400, 'Bad Request', { 'content-type': 'application/json' }, json, req)
    expect(err).toBeInstanceOf(HTTPError)
    expect((err as HTTPError).odata?.message).toBe('Unknown OData error')
  })

  describe('IIS 400 "Invalid URL" (#181)', () => {
    // The page http.sys serves, as captured from a 1С base behind IIS.
    const iisBody =
      '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN""http://www.w3.org/TR/html4/strict.dtd">\n' +
      '<HTML><HEAD><TITLE>Bad Request</TITLE>\n' +
      '<META HTTP-EQUIV="Content-Type" Content="text/html; charset=us-ascii"></HEAD>\n' +
      '<BODY><h2>Bad Request - Invalid URL</h2>\n<hr><p>HTTP Error 400. The request URL is invalid.</p>\n</BODY></HTML>'
    const html = { 'content-type': 'text/html; charset=us-ascii' }
    const guid = (i: number) => `Account_Key eq guid'04f7d9b4-2e97-11e8-ab43-00155df1a8${String(i).padStart(2, '0')}'`
    const vt = (n: number) =>
      `Turnovers(StartPeriod=datetime'2026-01-01T00:00:00',EndPeriod=datetime'2026-01-31T23:59:59',` +
      `AccountCondition='${Array.from({ length: n }, (_, i) => guid(i)).join(' or ')}')`
    const base = 'http://1c.test/bp/odata/standard.odata'

    it('names the per-segment limit and points to the query-string form when a decoded segment is over 260', async () => {
      const url = `${base}/${encodeURIComponent('AccountingRegister_Хозрасчетный')}/${encodeURIComponent(vt(3))}`
      const err = await mapResponseToError(400, 'Bad Request', html, iisBody, { method: 'GET', url })
      expect(err).toBeInstanceOf(HTTPError)
      expect((err as HTTPError).errorFormat).toBe('none')
      expect((err as HTTPError).status).toBe(400)
      expect(err.message).toContain(`a path segment is ${vt(3).length} characters`)
      expect(err.message).toContain('UrlSegmentMaxLength')
      expect(err.message).toContain('register_query')
      expect(err.message).toContain('split the condition into calls over disjoint subsets')
      expect((err as HTTPError).rawBody).toContain('Invalid URL')
    })

    it('splits segments on an encoded slash too, as IIS does', async () => {
      // 262 chars with the register name, 230 without: IIS accepts this (measured).
      const url = `${base}/${encodeURIComponent(`AccountingRegister_Хозрасчетный/${vt(2)}`)}`
      const err = await mapResponseToError(400, 'Bad Request', html, iisBody, { method: 'GET', url })
      expect(err.message).not.toContain('a path segment is')
      expect(err.message).toContain('IIS rejected the request URL as invalid')
    })

    it('gives the general IIS text when no segment is over the limit', async () => {
      const url = `${base}/Catalog_X`
      const err = await mapResponseToError(400, 'Bad Request', html, iisBody, { method: 'GET', url })
      expect(err.message).toMatch(
        /^HTTP 400 Bad Request: IIS rejected the request URL as invalid \("Invalid URL"\) — check the path/,
      )
    })

    it('measures a segment whose escapes do not decode by counting each %XX once', async () => {
      // A stray '%' (e.g. a LIKE pattern) makes the path undecodable: IIS rejects the escape, not the length.
      const url = `${base}/${encodeURIComponent('AccountingRegister_Хозрасчетный')}/Turnovers(Condition='${'Хозрасчетный'.repeat(8)} like %G1')`
      const err = await mapResponseToError(400, 'Bad Request', html, iisBody, { method: 'GET', url })
      expect(err.message).not.toContain('a path segment is')
    })

    it('splits on an encoded slash even where another escape does not decode', async () => {
      // Two ~200-char halves joined by %2F, with a stray '%' in one: neither decoded segment is over 260.
      const half = 'Х'.repeat(200)
      const url = `${base}/${encodeURIComponent(`${half}/${half}`)}%G1`
      const err = await mapResponseToError(400, 'Bad Request', html, iisBody, { method: 'GET', url })
      expect(err.message).not.toContain('a path segment is')
    })

    it('matches the media type case-insensitively', async () => {
      const url = `${base}/${encodeURIComponent(vt(3))}`
      const err = await mapResponseToError(400, 'Bad Request', { 'content-type': 'TEXT/HTML' }, iisBody, {
        method: 'GET',
        url,
      })
      expect(err.message).toContain('a path segment is')
    })

    it('does not take a non-HTML 400 that merely mentions "Invalid URL" for the IIS page', async () => {
      const url = `${base}/${encodeURIComponent(vt(3))}`
      const err = await mapResponseToError(400, 'Bad Request', { 'content-type': 'text/plain' }, 'Invalid URL scheme', {
        method: 'GET',
        url,
      })
      expect(err.message).toContain('server returned no OData error envelope')
      expect(err.message).toContain('Body starts: Invalid URL scheme')
    })

    it('leaves other no-envelope 400s on the generic text', async () => {
      const url = `${base}/${encodeURIComponent(vt(3))}`
      const err = await mapResponseToError(400, 'Bad Request', html, '<html>Bad Request</html>', { method: 'GET', url })
      expect(err.message).toContain('server returned no OData error envelope')
    })
  })
})
