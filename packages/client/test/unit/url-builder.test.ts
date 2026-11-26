import { runInNewContext } from 'node:vm'
import { InvalidArgumentError, QueryBuilder } from '@1c-odata/client'
import { describe, expect, it } from 'vitest'
import { buildV3CollectionUrl, buildV3CountUrl, buildV3KeyUrl, type EntityKey } from '../../src/url-builder.js'

/** A keyed URL for a connection in Europe/Moscow. */
const keyUrl = (base: string, set: string, key: EntityKey) => buildV3KeyUrl(base, set, key, 'Europe/Moscow')

const base = 'http://1c.test/odata/standard.odata'

describe('V3 URL builder', () => {
  it('builds simple entity-set URL with $format=json nometadata', () => {
    const q = new QueryBuilder('Catalog_Валюты', 'Europe/Moscow')
    const url = buildV3CollectionUrl(base, q)
    expect(url).toBe(
      `${base}/Catalog_%D0%92%D0%B0%D0%BB%D1%8E%D1%82%D1%8B?%24format=application%2Fjson%3Bodata%3Dnometadata`,
    )
  })

  it('appends $top + $skip + $select', () => {
    const q = new QueryBuilder('Catalog_X', 'Europe/Moscow').top(10).skip(20).select('Code', 'Description')
    const url = buildV3CollectionUrl(base, q)
    expect(url).toContain('%24top=10')
    expect(url).toContain('%24skip=20')
    expect(url).toContain('%24select=Code%2CDescription')
  })

  it('appends $filter from FilterExpression', () => {
    const q = new QueryBuilder<{ DeletionMark: boolean }>('Catalog_X', 'Europe/Moscow').filter((f) =>
      f.DeletionMark.eq(false),
    )
    const url = buildV3CollectionUrl(base, q)
    expect(url).toContain('%24filter=DeletionMark%20eq%20false')
  })

  it('appends $orderby with mixed directions', () => {
    const q = new QueryBuilder('Catalog_X', 'Europe/Moscow').orderBy('Code').orderBy('Date', 'desc')
    const url = buildV3CollectionUrl(base, q)
    expect(url).toContain('%24orderby=Code%20asc%2CDate%20desc')
  })

  it('appends $expand', () => {
    const q = new QueryBuilder('Document_X', 'Europe/Moscow').expand('Контрагент', 'Организация')
    const url = buildV3CollectionUrl(base, q)
    expect(url).toContain(
      '%24expand=%D0%9A%D0%BE%D0%BD%D1%82%D1%80%D0%B0%D0%B3%D0%B5%D0%BD%D1%82%2C%D0%9E%D1%80%D0%B3%D0%B0%D0%BD%D0%B8%D0%B7%D0%B0%D1%86%D0%B8%D1%8F',
    )
  })

  it('sends no $select / $expand for an empty list (#237) — get() and count() alike', () => {
    const q = new QueryBuilder<{ Code: string }>('Catalog_X', 'Europe/Moscow').select(...([] as 'Code'[])).expand()
    for (const url of [buildV3CollectionUrl(base, q), buildV3CountUrl(base, q)]) {
      expect(url).not.toContain('%24select')
      expect(url).not.toContain('%24expand')
    }
    // A later non-empty call still sends its fields.
    expect(buildV3CollectionUrl(base, q.select('Code'))).toContain('%24select=Code')
    expect(buildV3CountUrl(base, q.expand('Code'))).toContain('%24expand=Code')
  })

  it('appends $inlinecount=allpages', () => {
    const q = new QueryBuilder('Catalog_X', 'Europe/Moscow').withCount()
    const url = buildV3CollectionUrl(base, q)
    expect(url).toContain('%24inlinecount=allpages')
  })

  it('builds keyed URL with single GUID key', () => {
    const url = keyUrl(base, 'Catalog_X', '818ed18b-76c9-11e4-8918-003048663bbb')
    expect(url).toBe(
      `${base}/Catalog_X(guid'818ed18b-76c9-11e4-8918-003048663bbb')?%24format=application%2Fjson%3Bodata%3Dnometadata`,
    )
  })

  it('builds keyed URL with composite key (Recorder + Recorder_Type)', () => {
    const url = keyUrl(base, 'AccumulationRegister_X', {
      Recorder: '818ed18b-76c9-11e4-8918-003048663bbb',
      Recorder_Type: 'StandardODATA.Document_X',
    })
    expect(url).toContain("Recorder=guid'818ed18b-76c9-11e4-8918-003048663bbb'")
    expect(url).toContain("Recorder_Type='StandardODATA.Document_X'")
  })

  it('composite-key string value with reserved chars is percent-encoded inside the OData literal', () => {
    // OData literal delimiters `'`, `=`, `,` stay raw — they're syntax. The
    // value content (including spaces, `&`, `?`) MUST be URL-encoded so it
    // can't break the URL or be reinterpreted as query syntax.
    //
    // `encodeURIComponent` leaves `'`, `(`, `)`, `*`, `!`, `~` unencoded by
    // design (the ECMAScript spec carves out these "marks" so encoded URIs
    // stay readable for common literals). That's exactly what the OData
    // literal layer needs: doubled `''` apostrophes survive, and an embedded
    // `)` inside `'...'` is safe because the OData server tokenizes literals
    // by grammar, not by paren-counting.
    const url = keyUrl(base, 'InformationRegister_X', {
      Period: '2025-01-01T00:00:00',
      Code: "A&B C?D)'E",
    })
    // A string stays a quoted string literal — 1С converts it to the field's type (#194).
    expect(url).toContain("Period='2025-01-01T00%3A00%3A00'")
    expect(url).toContain("Code='A%26B%20C%3FD)''E'")
  })

  it('buildV3CountUrl appends /$count and preserves $filter', () => {
    const q = new QueryBuilder<{ DeletionMark: boolean }>('Catalog_X', 'Europe/Moscow').filter((f) =>
      f.DeletionMark.eq(false),
    )
    const url = buildV3CountUrl(base, q)
    expect(url).toContain('/$count')
    expect(url).toContain('%24filter')
    expect(url).not.toContain('%24format') // /$count returns plain integer, no format needed
  })

  it('buildV3CountUrl carries $select and $expand — the rows 1С counts — and no paging (#215)', () => {
    const q = new QueryBuilder<{ DeletionMark: boolean } & Record<string, unknown>>('Catalog_X', 'Europe/Moscow')
      .filter((f) => f.DeletionMark.eq(false))
      .select('Description', 'Owner/Description')
      .expand('Owner')
      .orderBy('Description')
      .top(5)
      .skip(10)
      .withCount()
    const url = buildV3CountUrl(base, q)
    expect(url).toBe(
      `${base}/Catalog_X/$count?%24filter=DeletionMark%20eq%20false&%24select=Description%2COwner%2FDescription&%24expand=Owner`,
    )
  })

  it('buildV3CountUrl keeps $select on a register virtual table in the path (#215)', () => {
    const q = new QueryBuilder('AccumulationRegister_Товары/Balance', 'Europe/Moscow').select('Номенклатура_Key')
    const url = buildV3CountUrl(base, q)
    // The set path is one segment (encodeSegment); 1С counts it with the $select: 1416 rows, as the page holds,
    // against 1574 without it on УТ 11.5 AccumulationRegister_ТоварыНаСкладах/Balance, $select=Номенклатура_Key.
    expect(url).toBe(
      `${base}/${encodeURIComponent('AccumulationRegister_Товары/Balance')}/$count?%24select=${encodeURIComponent('Номенклатура_Key')}`,
    )
  })
})

describe('V3 URL builder — entity set as one segment', () => {
  const base = 'http://h/odata'
  it.each(['', '.', '..'])('rejects the entity set %j, which would collapse into the path above the base', (set) => {
    expect(() => buildV3CollectionUrl(base, new QueryBuilder(set, 'Europe/Moscow'))).toThrow(InvalidArgumentError)
    expect(() => buildV3CountUrl(base, new QueryBuilder(set, 'Europe/Moscow'))).toThrow(InvalidArgumentError)
    expect(() => keyUrl(base, set, '11111111-2222-3333-4444-555555555555')).toThrow(InvalidArgumentError)
  })

  it('rejects a set name that cannot be encoded (a lone surrogate) as an InvalidArgumentError', () => {
    expect(() => buildV3CollectionUrl(base, new QueryBuilder('Catalog_\ud800', 'Europe/Moscow'))).toThrow(
      InvalidArgumentError,
    )
  })

  it('still encodes a set path with a slash into one segment', () => {
    expect(buildV3CollectionUrl(base, new QueryBuilder('Register_X/Balance()', 'Europe/Moscow'))).toMatch(
      /^http:\/\/h\/odata\/Register_X%2FBalance\(\)\?/,
    )
  })
})

describe('V3 URL builder — entity keys cannot rewrite the path', () => {
  const base = 'http://h/odata'
  const G = '11111111-2222-3333-4444-555555555555'

  it.each([
    ['a path-escaping string', "x')/../../hs/svc?a=('"],
    ['a non-GUID string', 'abc'],
    ['an empty string', ''],
  ])('rejects %s as a key', (_name, key) => {
    expect(() => keyUrl(base, 'Catalog_X', key)).toThrow(InvalidArgumentError)
  })

  it.each([
    ['a field with a slash', { 'Recorder/../x': G }],
    ['a field with a quote', { "A')": G }],
    ['an empty composite key', {}],
  ])('rejects %s', (_name, key) => {
    expect(() => keyUrl(base, 'InformationRegister_X', key as Record<string, string>)).toThrow(InvalidArgumentError)
  })

  it('rejects an array as a composite key', () => {
    const key = ['11111111-2222-3333-4444-555555555555'] as unknown as Record<string, string>
    expect(() => keyUrl(base, 'Catalog_X', key)).toThrow(InvalidArgumentError)
  })

  it('writes composite-key values by JS type, as the 1С docs show them (#194)', () => {
    const period = new Date('2024-12-31T21:00:00Z') // 2025-01-01 00:00 in Moscow
    expect(keyUrl(base, 'InformationRegister_X', { Period: period, Валюта_Key: G })).toContain(
      `(Period=datetime'2025-01-01T00:00:00',Валюта_Key=guid'${G}')`,
    )
    expect(keyUrl(base, 'Document_X_Товары', { Ref_Key: G, LineNumber: 1 })).toContain(
      `(Ref_Key=guid'${G}',LineNumber=1)`,
    )
    expect(keyUrl(base, 'Document_X_Товары', { Ref_Key: G, LineNumber: 12345678901234567890n })).toContain(
      'LineNumber=12345678901234567890)',
    )
    expect(keyUrl(base, 'InformationRegister_X', { НомерСообщения: 1, Исходящее: false, ЕстьОшибка: true })).toContain(
      '(НомерСообщения=1,Исходящее=false,ЕстьОшибка=true)',
    )
    // A string number is still a string literal.
    expect(keyUrl(base, 'Document_X_Товары', { LineNumber: '1' })).toContain("(LineNumber='1')")
  })

  it('writes a Date from another realm, by its own time value (#194)', () => {
    const foreign = runInNewContext("new Date('2024-12-31T21:00:00Z')") as Date
    expect(keyUrl(base, 'InformationRegister_X', { Period: foreign })).toContain(
      "(Period=datetime'2025-01-01T00:00:00')",
    )
    class Shifted extends Date {
      override getTime(): number {
        return super.getTime() + 3_600_000
      }
    }
    expect(keyUrl(base, 'InformationRegister_X', { Period: new Shifted('2024-12-31T21:00:00Z') })).toContain(
      "(Period=datetime'2025-01-01T00:00:00')",
    )
  })

  it('writes a Date key before year 1000 with four digits, and refuses one outside 0001–9999 (#194)', () => {
    expect(keyUrl(base, 'InformationRegister_X', { Period: new Date('0999-04-30T21:29:43Z') })).toContain(
      "(Period=datetime'0999-05-01T00:00:00')", // Moscow local mean time then: +02:30:17
    )
    expect(() => keyUrl(base, 'InformationRegister_X', { Period: new Date('9999-12-31T22:00:00Z') })).toThrow(
      'Composite-key field Period: Date 9999-12-31T22:00:00.000Z falls in year 10000',
    )
    try {
      keyUrl(base, 'InformationRegister_X', { Period: new Date('0000-06-01T00:00:00Z') })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidArgumentError)
      expect((err as InvalidArgumentError).argument).toBe('key')
    }
  })

  it('writes a Date key in the connection serverTimezone, milliseconds kept', () => {
    const period = new Date('2025-07-01T09:30:00.250Z')
    expect(buildV3KeyUrl(base, 'InformationRegister_X', { Period: period }, 'America/New_York')).toContain(
      "(Period=datetime'2025-07-01T05:30:00.250')",
    )
  })

  it.each([
    ['an invalid Date', new Date(Number.NaN), 'invalid Date'],
    ['a non-finite number', Number.POSITIVE_INFINITY, 'finite number'],
    ['null', null, 'must be a string, number, bigint, boolean or Date'],
    ['an object', { a: 1 }, 'must be a string, number, bigint, boolean or Date'],
  ])('rejects %s as a composite-key value', (_name, value, why) => {
    const key = { Period: value } as unknown as EntityKey
    expect(() => keyUrl(base, 'InformationRegister_X', key)).toThrow(InvalidArgumentError)
    expect(() => keyUrl(base, 'InformationRegister_X', key)).toThrow(why)
    try {
      keyUrl(base, 'InformationRegister_X', key)
    } catch (err) {
      expect((err as InvalidArgumentError).argument).toBe('key')
    }
  })

  it('keeps a virtual-table path whose quoted argument holds slashes', () => {
    const set = "Register_X/SliceLast(Condition='Сайт eq ''https://example.org/a//b''')"
    expect(() => buildV3CollectionUrl(base, new QueryBuilder(set, 'Europe/Moscow'))).not.toThrow()
  })

  it.each(['X/..', 'X//Y', './X', 'X\\..', 'Register_X/Balance()/../..'])(
    'rejects the set path %j, whose parts would collapse',
    (set) => {
      expect(() => buildV3CollectionUrl(base, new QueryBuilder(set, 'Europe/Moscow'))).toThrow(InvalidArgumentError)
    },
  )

  it('keeps a GUID key and a composite key of 1С names', () => {
    expect(keyUrl(base, 'Catalog_X', G)).toBe(
      `${base}/Catalog_X(guid'${G}')?%24format=application%2Fjson%3Bodata%3Dnometadata`,
    )
    expect(keyUrl(base, 'InformationRegister_X', { Recorder: G, Валюта: "a/b'c" })).toContain(
      `(Recorder=guid'${G}',Валюта='a%2Fb''c')`,
    )
  })

  it('answers a lone surrogate in a key value or a query option with InvalidArgumentError', () => {
    expect(() => keyUrl(base, 'InformationRegister_X', { Code: 'a\ud800' })).toThrow(InvalidArgumentError)
    const q = new QueryBuilder('Catalog_X', 'Europe/Moscow').select('A\ud800' as never)
    expect(() => buildV3CollectionUrl(base, q)).toThrow(InvalidArgumentError)
  })
})
