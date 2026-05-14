import { BasicAuth, InvalidArgumentError, ODataV3Client } from '@1c-odata/client'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildFunctionUrl, serializeArgs } from '../../src/functions.js'

describe('serializeArgs', () => {
  it('quotes string values (Cyrillic + spaces percent-encoded at wire level)', () => {
    expect(serializeArgs({ Condition: "Касса_Key eq guid'...'" }, 'Europe/Moscow')).toBe(
      `Condition='%D0%9A%D0%B0%D1%81%D1%81%D0%B0_Key%20eq%20guid''...'''`,
    )
  })
  it('formats Date as datetime literal in server timezone (Europe/Moscow = UTC+3)', () => {
    // UTC 07:30:00 = Moscow wall-clock 10:30:00 (UTC+3, no DST in Jan).
    // `:` inside the datetime literal is percent-encoded to `%3A` per RFC 3986.
    const d = new Date(Date.UTC(2025, 0, 15, 7, 30, 0))
    expect(serializeArgs({ Period: d }, 'Europe/Moscow')).toBe(`Period=datetime'2025-01-15T10%3A30%3A00'`)
  })
  it('numbers as-is', () => {
    expect(serializeArgs({ Top: 50 }, 'Europe/Moscow')).toBe(`Top=50`)
  })
  it('booleans as true/false', () => {
    expect(serializeArgs({ Posted: true, Deleted: false }, 'Europe/Moscow')).toBe(`Posted=true&Deleted=false`)
  })
  it('null becomes the OData literal `null`', () => {
    expect(serializeArgs({ Period: null }, 'Europe/Moscow')).toBe(`Period=null`)
  })
  it('skips undefined', () => {
    expect(serializeArgs({ Period: undefined, Code: 'X' }, 'Europe/Moscow')).toBe(`Code='X'`)
  })
  it('returns empty string for {}', () => {
    expect(serializeArgs({}, 'Europe/Moscow')).toBe('')
  })
  it('throws InvalidArgumentError on NaN argument', () => {
    expect(() => serializeArgs({ Сумма: Number.NaN }, 'Europe/Moscow')).toThrow(InvalidArgumentError)
  })
  it('throws InvalidArgumentError on +Infinity argument', () => {
    expect(() => serializeArgs({ Top: Number.POSITIVE_INFINITY }, 'Europe/Moscow')).toThrow(InvalidArgumentError)
  })
  it('throws InvalidArgumentError on -Infinity argument', () => {
    expect(() => serializeArgs({ Delta: Number.NEGATIVE_INFINITY }, 'Europe/Moscow')).toThrow(InvalidArgumentError)
  })
  it('InvalidArgumentError carries the offending arg key as `argument`', () => {
    try {
      serializeArgs({ Сумма: Number.NaN }, 'Europe/Moscow')
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidArgumentError)
      expect((e as InvalidArgumentError).argument).toBe('Сумма')
    }
  })
})

describe('serializeArgs — @odata.bind shape', () => {
  it('@odata.bind values are emitted as quoted URI literals', () => {
    expect(
      serializeArgs(
        {
          AccountDr: { '@odata.bind': "Catalog_X(guid'g')" },
        },
        'Europe/Moscow',
      ),
    ).toBe(`AccountDr='Catalog_X(guid''g'')'`)
  })

  it('multiple @odata.bind args concatenate correctly', () => {
    const out = serializeArgs(
      {
        AccountDr: { '@odata.bind': "Catalog_X(guid'g1')" },
        AccountCr: { '@odata.bind': "Catalog_Y(guid'g2')" },
      },
      'Europe/Moscow',
    )
    expect(out).toContain(`AccountDr='Catalog_X(guid''g1'')'`)
    expect(out).toContain(`AccountCr='Catalog_Y(guid''g2'')'`)
  })

  it('unsupported object falls back to quoted-string form (not bare [object Object])', () => {
    // `[`, `]`, and space percent-encoded by URL-level encoding pass.
    expect(serializeArgs({ Foo: { unknown: 'shape' } }, 'Europe/Moscow')).toBe(`Foo='%5Bobject%20Object%5D'`)
  })

  it('keys containing `@` are percent-encoded (e.g. literal @odata.bind property key)', () => {
    // Real-world shape from `DrCrTurnoversArgs`: when the user passes a literal
    // `AccountDr@odata.bind` key (instead of the wrapped `{ '@odata.bind': ... }`
    // shape), the `@` MUST be encoded as `%40` — leaving it raw confuses some
    // query-string parsers that treat `@` as gen-delim.
    expect(serializeArgs({ 'AccountDr@odata.bind': "Catalog_X(guid'g')" }, 'Europe/Moscow')).toBe(
      `AccountDr%40odata.bind='Catalog_X(guid''g'')'`,
    )
  })
})

describe('buildFunctionUrl', () => {
  const base = 'http://example.test/odata'
  const REF = '11111111-2222-3333-4444-555555555555'
  it('instance-bound: <set>(<ref>)/<func>()?args', () => {
    expect(buildFunctionUrl(base, 'Document_РТУ', 'Post', { ref: REF }, {}, 'Europe/Moscow')).toBe(
      `${base}/Document_РТУ(guid'${REF}')/Post()`,
    )
  })
  it('instance-bound with extra args: <set>(<ref>)/<func>()?args', () => {
    expect(
      buildFunctionUrl(base, 'Document_РТУ', 'Post', { ref: REF }, { PostingModeOperational: false }, 'Europe/Moscow'),
    ).toBe(`${base}/Document_РТУ(guid'${REF}')/Post()?PostingModeOperational=false`)
  })
  it('set-bound: <set>/<func>()?args (no ref) — Date formatted in server timezone', () => {
    // UTC 07:30:00 = Moscow wall-clock 10:30:00 (UTC+3, no DST in Jan).
    // `:` inside the datetime literal is percent-encoded in the query string.
    const d = new Date(Date.UTC(2025, 0, 15, 7, 30, 0))
    expect(buildFunctionUrl(base, 'AccumulationRegister_X', 'Balance', {}, { Period: d }, 'Europe/Moscow')).toBe(
      `${base}/AccumulationRegister_X/Balance()?Period=datetime'2025-01-15T10%3A30%3A00'`,
    )
  })
  it('throws InvalidArgumentError on non-GUID ref (apostrophe could escape the OData literal)', () => {
    expect(() => buildFunctionUrl(base, 'Document_X', 'Post', { ref: "not-a-guid')/X(" }, {}, 'Europe/Moscow')).toThrow(
      /must be a GUID/,
    )
  })
})

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
beforeEach(() => server.resetHandlers())

const baseUrl = 'http://example.test/odata'
const auth = BasicAuth({ username: 'u', password: 'p' })

describe('client.functions runtime Proxy', () => {
  it('write FI: POST <set>(<ref>)/<func>() with args as query string, returns void', async () => {
    const REF = '11111111-2222-3333-4444-555555555555'
    let receivedUrl: string | null = null
    let receivedMethod: string | null = null
    server.use(
      // URL contains parens — MSW path-to-regexp needs a regex matcher.
      // Node's fetch percent-encodes Cyrillic in the path; it does NOT encode `'`.
      http.post(new RegExp(`Document_%D0%A0%D0%A2%D0%A3\\(guid'${REF}'\\)\\/Post\\(\\)`), ({ request }) => {
        receivedUrl = request.url
        receivedMethod = request.method
        return HttpResponse.json({})
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const r = await c.functions.Document_РТУ.Post({ ref: REF, PostingModeOperational: false })
    expect(receivedMethod).toBe('POST')
    // undici encodes Cyrillic but leaves `'` unescaped.
    expect(receivedUrl).toContain(`Document_%D0%A0%D0%A2%D0%A3(guid'${REF}')/Post()`)
    expect(receivedUrl).toContain('PostingModeOperational=false')
    expect(r).toBeUndefined()
  })

  it('read FI: GET <set>/<func>() returns parsed value array', async () => {
    server.use(
      http.get(/\/AccumulationRegister_X\/Balance\(\).*/, () =>
        HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#X`,
          value: [{ Количество: 5 }, { Количество: 7 }],
        }),
      ),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const r = await c.functions.AccumulationRegister_X.Balance({ Period: new Date(2025, 0, 1) })
    expect(r).toEqual([{ Количество: 5 }, { Количество: 7 }])
  })

  it('read FI without ref hits set-bound URL', async () => {
    let url: string | null = null
    server.use(
      http.get(/\/InformationRegister_X\/SliceLast\(\).*/, ({ request }) => {
        url = request.url
        return HttpResponse.json({ 'odata.metadata': '#X', value: [] })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.functions.InformationRegister_X.SliceLast({ Period: new Date(2025, 0, 1) })
    expect(url).toContain('InformationRegister_X/SliceLast()')
    expect(url).not.toContain('(guid')
  })
})

describe('client.functions Proxy — defensive against thenable probe', () => {
  it('await c.functions.<EntitySet> resolves quickly without firing HTTP', async () => {
    let networkCalls = 0
    server.use(
      http.get(/.*/, () => {
        networkCalls++
        return HttpResponse.json({ 'odata.metadata': '#X', value: [] })
      }),
      http.post(/.*/, () => {
        networkCalls++
        return HttpResponse.json({})
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    // This MUST not hang and MUST not trigger any HTTP call
    const result = await c.functions.SomeSet
    expect(result).toBeDefined()
    expect(networkCalls).toBe(0)
  }, 5_000)

  it('c.functions.<Set>.then is undefined (not thenable)', () => {
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    expect((c.functions.X as unknown as { then?: unknown }).then).toBeUndefined()
  })
})

describe('client.functions Proxy — date mapping for read FIs', () => {
  it('parses Edm.DateTime strings to Date instances', async () => {
    server.use(
      http.get(/AccumulationRegister_X\/Balance\(\).*/, () =>
        HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#X`,
          value: [{ Period: '2025-01-15T10:30:00' }],
        }),
      ),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const result = await c.functions.AccumulationRegister_X.Balance({})
    expect(result).toHaveLength(1)
    expect((result as { Period: Date }[])[0]?.Period).toBeInstanceOf(Date)
  })

  it('maps 1С empty-date sentinel "0001-01-01T00:00:00" to null', async () => {
    server.use(
      http.get(/InformationRegister_Y\/SliceLast\(\).*/, () =>
        HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#Y`,
          value: [{ Period: '0001-01-01T00:00:00' }],
        }),
      ),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const result = await c.functions.InformationRegister_Y.SliceLast({})
    expect((result as { Period: Date | null }[])[0]?.Period).toBe(null)
  })
})
