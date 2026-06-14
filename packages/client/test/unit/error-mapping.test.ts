import { BusinessError, ConcurrencyError, HTTPError, ParseError, PermissionError } from '@1c-odata/client'
import { describe, expect, it } from 'vitest'
import { mapResponseToError } from '../../src/http/error-mapping.js'

describe('mapResponseToError', () => {
  it('maps HTTP 500 + code "-1" to BusinessError', async () => {
    const json = '{"odata.error":{"code":"-1","message":{"lang":"ru","value":"Не удалось провести \\"X\\""}}}'
    const err = await mapResponseToError(500, 'Internal Server Error', { 'content-type': 'application/json' }, json)
    expect(err).toBeInstanceOf(BusinessError)
    expect((err as HTTPError).code).toBe('-1')
  })

  it('maps HTTP 401 + code "20" to PermissionError', async () => {
    const json = '{"odata.error":{"code":"20","message":{"lang":"ru","value":"Нарушение прав доступа"}}}'
    const err = await mapResponseToError(401, 'Unauthorized', { 'content-type': 'application/json' }, json)
    expect(err).toBeInstanceOf(PermissionError)
  })

  it('maps HTTP 412 to ConcurrencyError', async () => {
    const json = '{"odata.error":{"code":"0","message":{"lang":"ru","value":"Версия не совпадает"}}}'
    const err = await mapResponseToError(412, 'Precondition Failed', { 'content-type': 'application/json' }, json)
    expect(err).toBeInstanceOf(ConcurrencyError)
  })

  it('maps generic 4xx/5xx to HTTPError', async () => {
    const json = '{"odata.error":{"code":"9","message":{"lang":"ru","value":"Экземпляр сущности не найден"}}}'
    const err = await mapResponseToError(404, 'Not Found', { 'content-type': 'application/json' }, json)
    expect(err).toBeInstanceOf(HTTPError)
    expect(err).not.toBeInstanceOf(BusinessError)
  })

  it('parses XML m:error body for $batch-style endpoints', async () => {
    const xml = `<?xml version="1.0"?><error xmlns="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"><code>0</code><message xml:lang="ru">Произошла ошибка сервиса</message></error>`
    const err = await mapResponseToError(501, 'Not Implemented', { 'content-type': 'application/xml' }, xml)
    expect(err).toBeInstanceOf(HTTPError)
    expect((err as HTTPError).code).toBe('0')
    expect((err as HTTPError).errorFormat).toBe('xml')
  })

  it('returns ParseError when a JSON-claimed body is invalid JSON', async () => {
    const err = await mapResponseToError(400, 'Bad Request', { 'content-type': 'application/json' }, 'not json')
    expect(err).toBeInstanceOf(ParseError)
  })

  it('returns ParseError when a JSON body is missing the odata.error wrapper', async () => {
    const err = await mapResponseToError(400, 'Bad Request', { 'content-type': 'application/json' }, '{"foo":1}')
    expect(err).toBeInstanceOf(ParseError)
  })

  describe('non-OData body (HTML error page)', () => {
    it('maps a 404 HTML body to an actionable HTTPError that keeps the status', async () => {
      const err = await mapResponseToError(
        404,
        'Not Found',
        { 'content-type': 'text/html; charset=utf-8' },
        '<html>...',
      )
      expect(err).toBeInstanceOf(HTTPError)
      expect(err).not.toBeInstanceOf(ParseError)
      const httpErr = err as HTTPError
      expect(httpErr.status).toBe(404)
      expect(httpErr.errorFormat).toBe('none')
      // Keeps status + content-type, and is actionable (calls out the over-long-URL remedy).
      expect(httpErr.message).toContain('HTTP 404')
      expect(httpErr.message).toContain('text/html; charset=utf-8')
      expect(httpErr.message).toMatch(/non-OData/)
      expect(httpErr.message).toMatch(/over-long request URL|fewer OR terms/)
      // The opaque legacy phrasing must be gone.
      expect(httpErr.message).not.toContain('Unrecognized error content-type')
      // body.message is the bare reason (no `HTTP …:` prefix), consistent with the
      // OData-envelope path; error.message = that prefix + body.message.
      expect(httpErr.body.message).not.toContain('HTTP ')
      expect(httpErr.body.message).toMatch(/^Server returned a non-OData/)
      expect(httpErr.message).toBe(`HTTP 404 Not Found: ${httpErr.body.message}`)
    })

    it('maps a 414 HTML body to HTTPError with the over-long-URL hint', async () => {
      const err = await mapResponseToError(414, 'Request-URI Too Long', { 'content-type': 'text/html' }, '<html>')
      expect(err).toBeInstanceOf(HTTPError)
      expect((err as HTTPError).status).toBe(414)
      expect((err as HTTPError).message).toMatch(/over-long request URL|fewer OR terms/)
    })

    it('still maps a 401 HTML body to PermissionError (status dispatch preserved)', async () => {
      const err = await mapResponseToError(401, 'Unauthorized', { 'content-type': 'text/html' }, '<html>401</html>')
      expect(err).toBeInstanceOf(PermissionError)
      expect((err as HTTPError).errorFormat).toBe('none')
    })

    it('handles a missing content-type without a double space', async () => {
      const err = await mapResponseToError(500, 'Internal Server Error', {}, 'oops')
      expect(err).toBeInstanceOf(HTTPError)
      expect((err as HTTPError).message).toContain('non-OData unknown body')
    })
  })
})
