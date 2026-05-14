import { QueryBuilder } from '@1c-odata/client'
import { describe, expect, it } from 'vitest'
import { buildV3CollectionUrl, buildV3CountUrl, buildV3KeyUrl } from '../../src/url-builder.js'

const base = 'http://1c.test/odata/standard.odata'

describe('V3 URL builder', () => {
  it('builds simple entity-set URL with $format=json nometadata', () => {
    const q = new QueryBuilder('Catalog_Валюты')
    const url = buildV3CollectionUrl(base, q)
    expect(url).toBe(
      `${base}/Catalog_%D0%92%D0%B0%D0%BB%D1%8E%D1%82%D1%8B?%24format=application%2Fjson%3Bodata%3Dnometadata`,
    )
  })

  it('appends $top + $skip + $select', () => {
    const q = new QueryBuilder('Catalog_X').top(10).skip(20).select('Code', 'Description')
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
    const q = new QueryBuilder('Catalog_X').orderBy('Code').orderBy('Date', 'desc')
    const url = buildV3CollectionUrl(base, q)
    expect(url).toContain('%24orderby=Code%20asc%2CDate%20desc')
  })

  it('appends $expand', () => {
    const q = new QueryBuilder('Document_X').expand('Контрагент', 'Организация')
    const url = buildV3CollectionUrl(base, q)
    expect(url).toContain(
      '%24expand=%D0%9A%D0%BE%D0%BD%D1%82%D1%80%D0%B0%D0%B3%D0%B5%D0%BD%D1%82%2C%D0%9E%D1%80%D0%B3%D0%B0%D0%BD%D0%B8%D0%B7%D0%B0%D1%86%D0%B8%D1%8F',
    )
  })

  it('appends $inlinecount=allpages', () => {
    const q = new QueryBuilder('Catalog_X').withCount()
    const url = buildV3CollectionUrl(base, q)
    expect(url).toContain('%24inlinecount=allpages')
  })

  it('builds keyed URL with single GUID key', () => {
    const url = buildV3KeyUrl(base, 'Catalog_X', '818ed18b-76c9-11e4-8918-003048663bbb')
    expect(url).toBe(
      `${base}/Catalog_X(guid'818ed18b-76c9-11e4-8918-003048663bbb')?%24format=application%2Fjson%3Bodata%3Dnometadata`,
    )
  })

  it('builds keyed URL with composite key (Recorder + Recorder_Type)', () => {
    const url = buildV3KeyUrl(base, 'AccumulationRegister_X', {
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
    const url = buildV3KeyUrl(base, 'InformationRegister_X', {
      Period: '2025-01-01T00:00:00',
      Code: "A&B C?D)'E",
    })
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
})
