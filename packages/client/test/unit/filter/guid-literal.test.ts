// A GUID string compared with a field holding a GUID is written `guid'…'` (#228):
// 1С matches no rows for `Ref_Key eq '…'` and fails `Идентификатор eq '…'` on an
// Edm.Guid attribute (live GET, trade 11.5), while `Recorder` — an Edm.String —
// fails the other way, on `guid'…'`. The schema decides where the query has one;
// otherwise the 1С naming rule `*_Key` does; `guid()` covers the rest.
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { InvalidArgumentError } from '../../../src/errors.js'
import { any, guid, toFilterString } from '../../../src/filter.js'
import { BasicAuth, ODataV3Client } from '../../../src/index.js'
import { QueryBuilder } from '../../../src/query/builder.js'
import { compileFilter, type FieldExprMap, type FilterExpression } from '../../../src/query/filter-internal.js'
import type { MetadataIndex } from '../../../src/validate.js'

const G = '8af68945-1c2d-11ef-9b6a-00155d102d01'

interface Row {
  Ref_Key: string
  Номенклатура_Key: string
  Идентификатор: string
  Recorder: string
  Code: string
  Товары: { Номенклатура_Key: string; КлючСтроки: string; Code: string }[]
}

const metadataIndex: MetadataIndex = {
  schemaNamespace: 'StandardODATA',
  schemas: {
    InformationRegister_X: {
      properties: {
        Ref_Key: { type: 'Edm.Guid', nullable: false },
        Номенклатура_Key: { type: 'Edm.Guid', nullable: true },
        Идентификатор: { type: 'Edm.Guid', nullable: false },
        Recorder: { type: 'Edm.String', nullable: false },
        Code: { type: 'Edm.String', nullable: false },
        Товары: { type: 'Collection(StandardODATA.InformationRegister_X_Товары_RowType)', nullable: true },
      },
    },
    InformationRegister_X_Товары_RowType: {
      properties: {
        Номенклатура_Key: { type: 'Edm.Guid', nullable: true },
        КлючСтроки: { type: 'Edm.Guid', nullable: false },
        Code: { type: 'Edm.String', nullable: false },
      },
    },
    // A property named `*_Key` that the schema says is a string: the schema wins.
    Catalog_Odd: { properties: { Внешний_Key: { type: 'Edm.String', nullable: true } } },
  },
  entitySetToType: {
    InformationRegister_X: 'InformationRegister_X',
    Catalog_Odd: 'Catalog_Odd',
  },
}

function client(index?: MetadataIndex) {
  return new ODataV3Client({
    baseUrl: 'http://1c.test/odata',
    auth: BasicAuth({ username: 'u', password: 'p' }),
    serverTimezone: 'Europe/Moscow',
    ...(index !== undefined ? { metadataIndex: index } : {}),
  })
}

const withIndex = (set: string, fn: (f: FieldExprMap<Row>) => FilterExpression): string => {
  const q = client(metadataIndex).query<Row>(set).filter(fn)
  return toFilterString(q.state.filter as FilterExpression)
}
const noIndex = (fn: (f: FieldExprMap<Row>) => FilterExpression): string => compileFilter<Row>('UTC', fn)

describe('filter DSL — a GUID string for a GUID field (#228)', () => {
  describe('with a MetadataIndex: the field type decides', () => {
    it('an Edm.Guid field writes a GUID string as guid', () => {
      expect(withIndex('InformationRegister_X', (f) => f.Ref_Key.eq(G))).toBe(`Ref_Key eq guid'${G}'`)
      expect(withIndex('InformationRegister_X', (f) => f.Идентификатор.ne(G))).toBe(`Идентификатор ne guid'${G}'`)
    })

    it('every comparison operator writes it so', () => {
      for (const op of ['eq', 'ne', 'gt', 'ge', 'lt', 'le'] as const) {
        const fn = (f: FieldExprMap<Row>) =>
          (f.Идентификатор as unknown as Record<string, (v: string) => FilterExpression>)[op]?.(G) as FilterExpression
        expect(withIndex('InformationRegister_X', fn)).toBe(`Идентификатор ${op} guid'${G}'`)
      }
    })

    it('an Edm.String field keeps a GUID string quoted — Recorder, a composite ref', () => {
      expect(withIndex('InformationRegister_X', (f) => f.Recorder.eq(G))).toBe(`Recorder eq '${G}'`)
      expect(withIndex('InformationRegister_X', (f) => f.Code.eq(G))).toBe(`Code eq '${G}'`)
    })

    it('the schema outranks the *_Key name rule', () => {
      const q = client(metadataIndex)
        .query<{ Внешний_Key: string }>('Catalog_Odd')
        .filter((f) => f.Внешний_Key.eq('not-a-guid'))
      expect(toFilterString(q.state.filter as FilterExpression)).toBe(`Внешний_Key eq 'not-a-guid'`)
    })

    it('a tabular row takes its row type from the index — also a GUID field not named *_Key', () => {
      expect(withIndex('InformationRegister_X', (f) => any(f.Товары, (t) => t.КлючСтроки.eq(G)))).toBe(
        `Товары/any(t0: t0/КлючСтроки eq guid'${G}')`,
      )
      expect(withIndex('InformationRegister_X', (f) => any(f.Товары, (t) => t.Code.eq(G)))).toBe(
        `Товары/any(t0: t0/Code eq '${G}')`,
      )
    })

    it('a field the schema does not list falls back to the *_Key name rule', () => {
      const q = client(metadataIndex)
        .query<{ Контрагент_Key: string; Прочее: string }>('InformationRegister_X')
        .filter((f) => f.Контрагент_Key.eq(G))
      expect(toFilterString(q.state.filter as FilterExpression)).toBe(`Контрагент_Key eq guid'${G}'`)
    })

    it('an entity set the index does not list falls back to the *_Key name rule', () => {
      expect(withIndex('Catalog_Unknown', (f) => f.Ref_Key.eq(G))).toBe(`Ref_Key eq guid'${G}'`)
      expect(withIndex('Catalog_Unknown', (f) => f.Идентификатор.eq(G))).toBe(`Идентификатор eq '${G}'`)
    })
  })

  describe('without a schema: the *_Key name rule', () => {
    it('a *_Key field writes a GUID string as guid — top level and in a lambda', () => {
      expect(noIndex((f) => f.Ref_Key.eq(G))).toBe(`Ref_Key eq guid'${G}'`)
      expect(noIndex((f) => f.Номенклатура_Key.ne(G))).toBe(`Номенклатура_Key ne guid'${G}'`)
      expect(noIndex((f) => any(f.Товары, (t) => t.Номенклатура_Key.eq(G)))).toBe(
        `Товары/any(t0: t0/Номенклатура_Key eq guid'${G}')`,
      )
    })

    it('a path ending in *_Key (an untyped key with a slash) reads the last segment', () => {
      const c = compileFilter<Record<string, string>>('UTC', (f) => f['Контрагент/Ref_Key']?.eq(G) as FilterExpression)
      expect(c).toBe(`Контрагент/Ref_Key eq guid'${G}'`)
    })

    it('upper-case hex is a GUID too', () => {
      expect(noIndex((f) => f.Ref_Key.eq(G.toUpperCase()))).toBe(`Ref_Key eq guid'${G.toUpperCase()}'`)
    })

    it('any other field keeps a GUID string quoted', () => {
      expect(noIndex((f) => f.Recorder.eq(G))).toBe(`Recorder eq '${G}'`)
      expect(noIndex((f) => f.Идентификатор.eq(G))).toBe(`Идентификатор eq '${G}'`)
    })

    it('null, a field and a computed expression are written as before', () => {
      expect(noIndex((f) => f.Ref_Key.eq(null as unknown as string))).toBe('Ref_Key eq null')
      expect(noIndex((f) => f.Номенклатура_Key.eq(f.Ref_Key))).toBe('Номенклатура_Key eq Ref_Key')
      // A computed expression is never a GUID field, whatever its text ends with.
      expect(noIndex((f) => f.Recorder.cast('StandardODATA.Document_X').eq(G))).toBe(
        `cast(Recorder, 'StandardODATA.Document_X') eq '${G}'`,
      )
    })
  })

  describe('a string that is not a GUID, for a GUID field', () => {
    it('is an InvalidArgumentError naming the field — by the *_Key rule', () => {
      let err: unknown
      try {
        noIndex((f) => f.Ref_Key.eq('8af68945'))
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(InvalidArgumentError)
      expect(err).toMatchObject({ argument: 'Ref_Key', received: '8af68945' })
    })

    it('is an InvalidArgumentError — by the schema', () => {
      expect(() => withIndex('InformationRegister_X', (f) => f.Идентификатор.eq("x' or 1 eq 1 or 'a"))).toThrow(
        InvalidArgumentError,
      )
      expect(() => withIndex('InformationRegister_X', (f) => any(f.Товары, (t) => t.КлючСтроки.eq(`{${G}}`)))).toThrow(
        InvalidArgumentError,
      )
    })
  })

  describe('guid()', () => {
    it('writes guid for any field — the schema-less Edm.Guid attribute, a navigation path', () => {
      expect(noIndex((f) => f.Идентификатор.eq(guid(G)))).toBe(`Идентификатор eq guid'${G}'`)
      const nav = compileFilter<Record<string, string>>(
        'UTC',
        (f) => f['Ответственный/ИдентификаторПользователяИБ']?.eq(guid(G)) as FilterExpression,
      )
      expect(nav).toBe(`Ответственный/ИдентификаторПользователяИБ eq guid'${G}'`)
    })

    it('every comparison operator takes it — ordering ones too', () => {
      expect(noIndex((f) => f.Идентификатор.gt(guid(G)))).toBe(`Идентификатор gt guid'${G}'`)
      expect(noIndex((f) => f.Идентификатор.ge(guid(G)))).toBe(`Идентификатор ge guid'${G}'`)
      expect(noIndex((f) => f.Идентификатор.lt(guid(G)))).toBe(`Идентификатор lt guid'${G}'`)
      expect(noIndex((f) => f.Идентификатор.le(guid(G)))).toBe(`Идентификатор le guid'${G}'`)
    })

    it('passes through a GUID field unchanged — no double wrapping', () => {
      expect(noIndex((f) => f.Ref_Key.eq(guid(G)))).toBe(`Ref_Key eq guid'${G}'`)
      expect(withIndex('InformationRegister_X', (f) => f.Ref_Key.ne(guid(G)))).toBe(`Ref_Key ne guid'${G}'`)
    })

    it('is a comparison value only — not an operand of a string, date or arithmetic function', () => {
      type Untyped = Record<string, (...v: unknown[]) => { eq(v: unknown): FilterExpression } & FilterExpression>
      const u = (e: unknown) => e as Untyped
      for (const build of [
        (f: FieldExprMap<Row>) => f.Code.concat(guid(G)).eq('x'),
        (f: FieldExprMap<Row>) => u(f.Code).startsWith?.(guid(G)) as FilterExpression,
        (f: FieldExprMap<Row>) => u(f.Code).like?.(guid(G)) as FilterExpression,
        (f: FieldExprMap<Row>) => u(f.Code).add?.(guid(G)).eq(1) as FilterExpression,
      ]) {
        expect(() => noIndex(build)).toThrow(InvalidArgumentError)
      }
    })

    it('refuses a field the schema types other than Edm.Guid — Recorder, Code', () => {
      expect(() => withIndex('InformationRegister_X', (f) => f.Recorder.eq(guid(G)))).toThrow(InvalidArgumentError)
      expect(() => withIndex('InformationRegister_X', (f) => f.Code.gt(guid(G)))).toThrow(InvalidArgumentError)
      // Without a schema the field's type is unknown: the caller says it holds a GUID.
      expect(noIndex((f) => f.Code.gt(guid(G)))).toBe(`Code gt guid'${G}'`)
    })

    it.each(['', 'not-a-guid', `${G} `, `{${G}}`, `${G}' or 'a`, 42 as unknown as string])(
      'refuses %j with an InvalidArgumentError',
      (v) => {
        expect(() => guid(v)).toThrow(InvalidArgumentError)
      },
    )
  })

  describe('a boxed string is read as the string it holds', () => {
    it('a String object on a GUID field is checked and written as guid', () => {
      const boxed = (s: string) => new String(s) as unknown as string
      expect(noIndex((f) => f.Ref_Key.eq(boxed(G)))).toBe(`Ref_Key eq guid'${G}'`)
      expect(() => noIndex((f) => f.Ref_Key.eq(boxed('not-a-guid')))).toThrow(InvalidArgumentError)
      // Another realm's String object too.
      const foreign = runInNewContext(`new String('${G}')`) as string
      expect(withIndex('InformationRegister_X', (f) => f.Идентификатор.eq(foreign))).toBe(`Идентификатор eq guid'${G}'`)
    })
  })

  describe('a plain QueryBuilder has no schema — the *_Key rule alone', () => {
    it('writes a *_Key field as guid', () => {
      const q = new QueryBuilder<Row>('InformationRegister_X', 'UTC').filter((f) => f.Ref_Key.eq(G))
      expect(toFilterString(q.state.filter as FilterExpression)).toBe(`Ref_Key eq guid'${G}'`)
    })
  })

  describe('an index naming an inherited key is no schema', () => {
    it('a set mapped to "constructor" falls back to the *_Key rule instead of a TypeError', () => {
      const odd: MetadataIndex = {
        schemaNamespace: 'StandardODATA',
        schemas: {},
        entitySetToType: { Catalog_X: 'constructor' },
      }
      const q = client(odd)
        .query<Row>('Catalog_X')
        .filter((f) => f.Ref_Key.eq(G))
      expect(toFilterString(q.state.filter as FilterExpression)).toBe(`Ref_Key eq guid'${G}'`)
      const proto = client(metadataIndex)
        .query<Row>('constructor')
        .filter((f) => f.Ref_Key.eq(G))
      expect(toFilterString(proto.state.filter as FilterExpression)).toBe(`Ref_Key eq guid'${G}'`)
    })
  })

  describe('a virtual-table path has no schema of its own — the *_Key rule', () => {
    it('writes a *_Key field as guid and leaves another GUID field to guid()', () => {
      expect(withIndex('InformationRegister_X/SliceLast()', (f) => f.Ref_Key.eq(G))).toBe(`Ref_Key eq guid'${G}'`)
      expect(withIndex('InformationRegister_X/SliceLast()', (f) => f.Идентификатор.eq(guid(G)))).toBe(
        `Идентификатор eq guid'${G}'`,
      )
    })
  })
})
