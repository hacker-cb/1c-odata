// A collection response carries its rows in a `value` array (#255). 1С sends
// one on every collection read, an empty result as `"value": []` — checked live
// (GET only) on trade 11.5: Catalog_Валюты with a filter matching nothing and
// with $top=0, InformationRegister_КурсыВалют/SliceLast and SliceFirst,
// AccumulationRegister_ТоварыНаСкладах/Balance, Turnovers, BalanceAndTurnovers;
// on bp 3.0: AccountingRegister_Хозрасчетный/Balance, RecordsWithExtDimensions,
// DrCrTurnovers. A body without it — a gateway's error page answered with 200,
// a truncated or foreign body — is a ParseError, never "no rows".
import { BasicAuth, ODataV3Client, ParseError } from '@1c-odata/client'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parseV3Collection } from '../../src/parser.js'

const TZ = 'Europe/Moscow'

function parseError(body: unknown): ParseError {
  try {
    parseV3Collection(JSON.stringify(body), { serverTimezone: TZ })
  } catch (e) {
    expect(e).toBeInstanceOf(ParseError)
    return e as ParseError
  }
  throw new Error('expected a ParseError')
}

describe('parseV3Collection — a body without a value array', () => {
  it('names the keys that came instead of value', () => {
    expect(parseError({ error: { code: 500, message: 'Bad gateway' } }).message).toBe(
      'Expected a "value" array in the collection response, got no "value" — keys "error"',
    )
    expect(parseError({ 'odata.metadata': 'http://x/$metadata#Catalog_X', 'odata.count': '3' }).message).toBe(
      'Expected a "value" array in the collection response, got no "value" — keys "odata.metadata", "odata.count"',
    )
  })

  it('shows at most five keys, each cut short, and never the values', () => {
    const body = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((k) => [k, 'секрет']))
    body['k'.repeat(60)] = 'секрет'
    const msg = parseError(body).message
    expect(msg).toBe(
      'Expected a "value" array in the collection response, got no "value" — keys "a", "b", "c", "d", "e", … (8 in all)',
    )
    expect(msg).not.toContain('секрет')
    const long = parseError({ ['k'.repeat(60)]: 1 }).message
    expect(long).toContain(`"${'k'.repeat(40)}…"`)
  })

  it('an empty object, and an array at the root', () => {
    expect(parseError({}).message).toBe(
      'Expected a "value" array in the collection response, got no "value" — an empty object',
    )
    expect(parseError([{ Ref_Key: 'a' }]).message).toBe(
      'Expected a "value" array in the collection response, got an array at root',
    )
  })

  it.each([
    [null, 'null'],
    [{}, 'an object'],
    ['', 'string ""'],
    [0, 'number 0'],
    ['x'.repeat(80), `string "${'x'.repeat(49)}…`],
  ])('a value that is no array — %j', (value, shown) => {
    expect(parseError({ value }).message).toBe(
      `Expected a "value" array in the collection response, got "value" ${shown}`,
    )
  })

  it.each([
    [null, 'null'],
    [5, 'number 5'],
    [[1], 'an array'],
  ])('a row that is no object — %j', (row, shown) => {
    expect(parseError({ value: [{ Code: '1' }, row] }).message).toBe(
      `Expected an object at value[1] of the collection response, got ${shown}`,
    )
  })

  it('an empty value array is an empty collection', () => {
    expect(parseV3Collection(JSON.stringify({ value: [] }), { serverTimezone: TZ }).value).toEqual([])
  })
})

describe('every collection read refuses a body without value', () => {
  const server = setupServer()
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  afterAll(() => server.close())
  beforeEach(() => server.resetHandlers())

  const baseUrl = 'http://example.test/odata'
  const gatewayError = { error: { code: 502, message: 'upstream timed out' } }
  const client = new ODataV3Client<{
    AccumulationRegister_X: { Balance(args: Record<string, unknown>): Promise<unknown> }
  }>({ baseUrl, auth: BasicAuth({ username: 'u', password: 'p' }), serverTimezone: TZ })

  it('query().get() and stream()', async () => {
    server.use(http.get(`${baseUrl}/Catalog_X`, () => HttpResponse.json(gatewayError)))
    await expect(client.query('Catalog_X').get()).rejects.toThrow(ParseError)
    const rows = async () => {
      for await (const _ of client.query('Catalog_X').stream()) {
        // no rows to read
      }
    }
    await expect(rows()).rejects.toThrow(ParseError)
  })

  it('a register virtual table', async () => {
    server.use(http.get(/\/AccumulationRegister_X\/Balance\(\)/, () => HttpResponse.json(gatewayError)))
    await expect(client.register('AccumulationRegister_X').balance({ Period: new Date(2025, 0, 1) })).rejects.toThrow(
      ParseError,
    )
  })

  it('a read function through client.functions', async () => {
    server.use(http.get(/\/AccumulationRegister_X\/Balance\(\)/, () => HttpResponse.json(gatewayError)))
    await expect(client.functions.AccumulationRegister_X.Balance({ Period: new Date(2025, 0, 1) })).rejects.toThrow(
      ParseError,
    )
  })
})
