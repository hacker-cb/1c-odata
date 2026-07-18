import { BasicAuth, InvalidArgumentError, ODataV3Client, ONEC_EMPTY_DATE, type UntypedEntity } from '@1c-odata/client'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// End-to-end contract of "what the client guarantees WITHOUT codegen and
// WITHOUT a metadataIndex" (STABILITY.md "Schema-less (untyped) contract").
// Each case goes through the public client API against an MSW-stubbed server.

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
beforeEach(() => server.resetHandlers())

const baseUrl = 'http://example.test/odata'
const auth = BasicAuth({ username: 'u', password: 'p' })

function makeClient(shape?: { dateMode?: 'date' | 'string'; int64Mode?: 'number' | 'bigint' | 'string' }) {
  return new ODataV3Client({
    baseUrl,
    auth,
    serverTimezone: 'Europe/Moscow',
    ...(shape !== undefined ? { shape } : {}),
  })
}

describe('schema-less READ contract', () => {
  it('DateTime strings parse to Date via the regex heuristic; sentinel → null; Int64 stays a string', async () => {
    server.use(
      http.get(`${baseUrl}/Document_X`, () =>
        HttpResponse.json({
          'odata.metadata': 'meta',
          'odata.count': '2',
          value: [
            { Ref_Key: 'a', Date: '2025-03-15T15:00:00', Cleared: '0001-01-01T00:00:00', BigNum: '9007199254740993' },
          ],
        }),
      ),
    )
    const { value, count } = await makeClient().query<UntypedEntity>('Document_X').withCount().get()
    const row = value[0]
    // naive wall-clock 15:00 Moscow = 12:00 UTC
    expect(row?.Date).toBeInstanceOf(Date)
    expect((row!.Date as Date).toISOString()).toBe('2025-03-15T12:00:00.000Z')
    expect(row?.Cleared).toBeNull()
    // Edm.Int64 needs a schema — stays a wire string without one.
    expect(row?.BigNum).toBe('9007199254740993')
    // odata.count (string on the wire) → number.
    expect(count).toBe(2)
  })

  it('dateMode string leaves DateTime wire strings untouched (sentinel included)', async () => {
    server.use(
      http.get(`${baseUrl}/Document_X`, () =>
        HttpResponse.json({
          'odata.metadata': 'meta',
          value: [{ Ref_Key: 'a', Date: '2025-03-15T15:00:00', Cleared: '0001-01-01T00:00:00' }],
        }),
      ),
    )
    const { value } = await makeClient({ dateMode: 'string' }).query('Document_X').get()
    expect(value[0]?.Date).toBe('2025-03-15T15:00:00')
    expect(value[0]?.Cleared).toBe(ONEC_EMPTY_DATE)
  })

  it('ValueStorage triples stay flat without a schema (no grouping)', async () => {
    // Cyrillic entity-set names arrive percent-encoded — match via RegExp
    // (same convention as transport-write.test.ts for parenthesised URLs).
    server.use(
      http.get(/Catalog_/, () =>
        HttpResponse.json({
          'odata.metadata': 'meta',
          value: [{ Ref_Key: 'a', ФайлХранилище_Base64Data: 'AAEC', ФайлХранилище_Type: 'image/png' }],
        }),
      ),
    )
    const { value } = await makeClient().query('Catalog_Файлы').get()
    expect(value[0]?.ФайлХранилище_Base64Data).toBe('AAEC')
    expect(value[0]?.ФайлХранилище_Type).toBe('image/png')
    expect(value[0]).not.toHaveProperty('ФайлХранилище')
  })
})

describe('schema-less WRITE contract', () => {
  it('create(): Date → naive ISO; null stays null; explicit sentinel passes through; response parses', async () => {
    let capturedBody: unknown
    server.use(
      http.post(`${baseUrl}/Document_X`, async ({ request }) => {
        capturedBody = await request.json()
        return HttpResponse.json(
          { 'odata.metadata': 'meta', Ref_Key: 'new-guid', Date: '2025-03-15T15:00:00' },
          { status: 201 },
        )
      }),
    )
    const created = await makeClient()
      .entity<UntypedEntity>('Document_X')
      .create({
        Date: new Date('2025-03-15T12:00:00Z'),
        Контрагент: null,
        ДатаОплаты: ONEC_EMPTY_DATE,
      })
    expect(capturedBody).toEqual({
      Date: '2025-03-15T15:00:00',
      Контрагент: null,
      ДатаОплаты: ONEC_EMPTY_DATE,
    })
    // The 201 response is parsed with the same read heuristics.
    expect(created.Ref_Key).toBe('new-guid')
    expect(created.Date).toBeInstanceOf(Date)
  })

  it('validateOnWrite without a metadataIndex throws InvalidArgumentError at construction', () => {
    expect(() => new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow', validateOnWrite: true })).toThrow(
      InvalidArgumentError,
    )
  })
})

describe('schema-less register / functions smoke', () => {
  it('register().balance() builds the FI URL and parses the response array', async () => {
    // Cyrillic set name is percent-encoded in the URL — match the FI suffix.
    server.use(
      http.get(/AccumulationRegister_.*\/Balance\(/, () =>
        HttpResponse.json({ 'odata.metadata': 'meta', value: [{ Товар_Key: 'g', КоличествоBalance: 5 }] }),
      ),
    )
    const rows = await makeClient().register('AccumulationRegister_Остатки').balance({})
    expect(rows).toEqual([{ Товар_Key: 'g', КоличествоBalance: 5 }])
  })

  it('functions proxy: read FI without ref goes through GET and parses value', async () => {
    server.use(
      http.get(/Catalog_.*\/SomeReadFi\(\)/, () => HttpResponse.json({ 'odata.metadata': 'meta', value: [{ X: 1 }] })),
    )
    const result = await makeClient().functions.Catalog_Валюты?.SomeReadFi?.({})
    expect(result).toEqual([{ X: 1 }])
  })
})
