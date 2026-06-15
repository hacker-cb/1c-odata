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
})
