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
