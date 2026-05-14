import { BusinessError, ConcurrencyError, HTTPError, ParseError, PermissionError } from '@1c-odata/client'
import { describe, expect, it } from 'vitest'
import { mapResponseToError } from '../../src/http/error-mapping.js'

describe('mapResponseToError', () => {
  it('maps HTTP 500 + code "-1" to BusinessError', async () => {
    const json = '{"odata.error":{"code":"-1","message":{"lang":"ru","value":"Не удалось провести \\"X\\""}}}'
    const err = await mapResponseToError(500, 'Internal Server Error', { 'content-type': 'application/json' }, json)
    expect(err).toBeInstanceOf(BusinessError)
    expect(err.code).toBe('-1')
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
    expect(err.code).toBe('0')
    expect(err.errorFormat).toBe('xml')
  })

  it('returns ParseError when body is neither JSON nor XML', async () => {
    const err = await mapResponseToError(
      500,
      'Internal Server Error',
      { 'content-type': 'text/html' },
      '<html>...</html>',
    )
    expect(err).toBeInstanceOf(ParseError)
  })
})
