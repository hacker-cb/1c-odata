// One rule finds a schema in a MetadataIndex — own keys only (#258). An index
// naming an inherited key (`constructor`, `toString`) for a type reaches the
// reader as `Object` through a plain lookup, and the first field of a row then
// fails with a TypeError. Load rejects such an index; every lookup, on read,
// write and in the filter DSL, treats the name as one the index does not hold.
import { BasicAuth } from '@1c-odata/client'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MetadataError } from '../../src/errors.js'
import { any, toFilterString } from '../../src/filter.js'
import { ODataV3Client } from '../../src/index.js'
import { parseMetadataIndex } from '../../src/load-metadata-index.js'
import { parseOptsFor, parseV3Collection, parseV3Single } from '../../src/parser.js'
import type { FilterExpression } from '../../src/query/filter-internal.js'
import {
  schemaOfRef,
  schemaOfSet,
  schemaOfType,
  typeNameOfNavigation,
  typeNameOfRef,
  typeNameOfSet,
} from '../../src/schema-lookup.js'
import type { MetadataIndex } from '../../src/validate.js'
import { transformDatesToWire } from '../../src/write-transform.js'

const row = {
  properties: {
    Ref_Key: { type: 'Edm.Guid', nullable: false },
    Идентификатор: { type: 'Edm.Guid', nullable: false },
    Сумма: { type: 'Edm.Int64', nullable: false },
    Дата: { type: 'Edm.DateTime', nullable: false },
  },
}

const index: MetadataIndex = {
  schemaNamespace: 'StandardODATA',
  schemas: {
    Catalog_X: {
      properties: {
        ...row.properties,
        Товары: { type: 'Collection(StandardODATA.Catalog_X_Товары)', nullable: false },
        Битые: { type: 'Collection(StandardODATA.constructor)', nullable: false },
        Вложенный: { type: 'StandardODATA.toString', nullable: false },
      },
    },
    Catalog_X_Товары: row,
  },
  entitySetToType: { Catalog_X: 'Catalog_X' },
}

/** An index no load let through: its set's type is an inherited key. */
const odd: MetadataIndex = {
  schemaNamespace: 'StandardODATA',
  schemas: { Catalog_X: index.schemas.Catalog_X as (typeof index.schemas)[string] },
  entitySetToType: { Catalog_X: 'constructor', Catalog_Y: 'toString' },
}

describe('schema-lookup', () => {
  it('finds a set, a type and a type reference by own keys', () => {
    expect(typeNameOfSet(index, 'Catalog_X')).toBe('Catalog_X')
    expect(schemaOfSet(index, 'Catalog_X')).toBe(index.schemas.Catalog_X)
    expect(schemaOfType(index, 'Catalog_X_Товары')).toBe(row)
    expect(typeNameOfRef(index, 'Collection(StandardODATA.Catalog_X_Товары)')).toBe('Catalog_X_Товары')
    expect(typeNameOfRef(index, 'StandardODATA.Catalog_X_Товары')).toBe('Catalog_X_Товары')
    expect(schemaOfRef(index, 'Catalog_X_Товары')).toBe(row)
  })

  it('an inherited name is no set and no type', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(typeNameOfSet(index, name)).toBeUndefined()
      expect(schemaOfSet(index, name)).toBeUndefined()
      expect(schemaOfType(index, name)).toBeUndefined()
      expect(schemaOfRef(index, `StandardODATA.${name}`)).toBeUndefined()
      expect(schemaOfRef(index, `Collection(StandardODATA.${name})`)).toBeUndefined()
    }
    expect(typeNameOfSet(odd, 'Catalog_X')).toBeUndefined()
    expect(schemaOfSet(odd, 'Catalog_Y')).toBeUndefined()
  })

  it('a primitive, an absent type, or no index resolves to nothing', () => {
    expect(typeNameOfRef(index, 'Edm.String')).toBeUndefined()
    expect(typeNameOfRef(index, 'Collection(Edm.String)')).toBeUndefined()
    expect(typeNameOfRef(index, 'StandardODATA.Catalog_Нет')).toBeUndefined()
    expect(typeNameOfRef(index, undefined)).toBeUndefined()
    expect(typeNameOfRef(undefined, 'StandardODATA.Catalog_X')).toBeUndefined()
    expect(schemaOfSet(undefined, 'Catalog_X')).toBeUndefined()
    expect(schemaOfType(index, undefined)).toBeUndefined()
  })
})

describe('typeNameOfNavigation (#283)', () => {
  const schema = {
    properties: {},
    navigation: {
      Строка: { type: 'Catalog_X_Товары' },
      Висячая: { type: 'Нет' },
      Унаследованная: { type: 'toString' },
    },
  }

  it("finds a navigation's target by own keys where the index holds its schema", () => {
    expect(typeNameOfNavigation(index, schema, 'Строка')).toBe('Catalog_X_Товары')
  })

  it('answers undefined for a name it does not list, an inherited one, a dangling or inherited target, no index', () => {
    expect(typeNameOfNavigation(index, schema, 'Другая')).toBeUndefined()
    expect(typeNameOfNavigation(index, schema, 'constructor')).toBeUndefined()
    expect(typeNameOfNavigation(index, schema, 'Висячая')).toBeUndefined()
    expect(typeNameOfNavigation(index, schema, 'Унаследованная')).toBeUndefined()
    expect(typeNameOfNavigation(index, { properties: {} }, 'Строка')).toBeUndefined()
    expect(typeNameOfNavigation(undefined, schema, 'Строка')).toBeUndefined()
  })
})

describe('parseMetadataIndex refuses a set whose type schemas does not hold', () => {
  it.each(['constructor', 'toString', 'Catalog_Нет'])('entitySetToType → %s', (type) => {
    const data = JSON.parse(JSON.stringify({ ...index, entitySetToType: { Catalog_X: 'Catalog_X', Catalog_Y: type } }))
    expect(() => parseMetadataIndex(data, 'cache.json')).toThrow(MetadataError)
    expect(() => parseMetadataIndex(data, 'cache.json')).toThrow(
      `Invalid metadata at cache.json $.entitySetToType.Catalog_Y: type ${JSON.stringify(type)} is not in $.schemas`,
    )
  })

  it('a type held under a non-enumerable key is none — the schemas validated are the enumerable ones', () => {
    const schemas = Object.defineProperty({}, 'Catalog_X', { value: 42, enumerable: false })
    const data = { schemaNamespace: 'StandardODATA', schemas, entitySetToType: { Catalog_X: 'Catalog_X' } }
    expect(() => parseMetadataIndex(data, 'cache.json')).toThrow(
      'Invalid metadata at cache.json $.entitySetToType.Catalog_X: type "Catalog_X" is not in $.schemas',
    )
  })

  it('takes an index whose every set names a type it holds', () => {
    const data = JSON.parse(JSON.stringify(index))
    expect(parseMetadataIndex(data).entitySetToType).toEqual({ Catalog_X: 'Catalog_X' })
  })
})

describe('an index that names an inherited key reads schema-less, not with a TypeError', () => {
  const client = { serverTimezone: 'UTC', metadataIndex: odd }
  const entity = { Ref_Key: 'k', Сумма: '5', Дата: '2024-01-02T03:04:05' }

  it('parseOptsFor gives no typeHint for such a set', () => {
    expect(parseOptsFor(client, 'Catalog_X').typeHint).toBeUndefined()
    expect(parseOptsFor(client, 'constructor').typeHint).toBeUndefined()
  })

  it('a collection and a single entity parse as without an index', () => {
    const body = JSON.stringify({ 'odata.metadata': 'm', value: [entity] })
    const [r] = parseV3Collection<Record<string, unknown>>(body, parseOptsFor(client, 'Catalog_X')).value
    // Schema-less: Int64 stays a string, the date is found by its shape.
    expect(r?.Сумма).toBe('5')
    expect(r?.Дата).toBeInstanceOf(Date)
    const one = parseV3Single<Record<string, unknown>>(JSON.stringify(entity), parseOptsFor(client, 'Catalog_Y'))
    expect(one.Сумма).toBe('5')
  })

  it('a typeHint passed straight in that names an inherited key is no schema', () => {
    const body = JSON.stringify({ value: [entity] })
    const opts = { serverTimezone: 'UTC', metadataIndex: index, typeHint: 'constructor' }
    expect(parseV3Collection<Record<string, unknown>>(body, opts).value[0]?.Сумма).toBe('5')
  })

  it('a nested value typed by an inherited key parses schema-less', () => {
    const body = JSON.stringify({
      value: [{ Сумма: '7', Битые: [{ Сумма: '1' }], Вложенный: { Сумма: '2' }, Товары: [{ Сумма: '3' }] }],
    })
    const [r] = parseV3Collection<Record<string, unknown>>(
      body,
      parseOptsFor({ ...client, metadataIndex: index }, 'Catalog_X'),
    ).value
    expect(r?.Сумма).toBe(7)
    expect(r?.Битые).toEqual([{ Сумма: '1' }])
    expect(r?.Вложенный).toEqual({ Сумма: '2' })
    // A row type the index holds still reads with its own schema.
    expect(r?.Товары).toEqual([{ Сумма: 3 }])
  })

  it('the write transform writes a nested value typed by an inherited key as without an index', () => {
    const d = new Date(Date.UTC(2024, 0, 2, 3, 4, 5))
    const out = transformDatesToWire(
      {
        Дата: d,
        Битые: [{ Дата: d, Код: 'x' }],
        Вложенный: { Дата: d, Код: 'y' },
        Товары: [{ Дата: d, Сумма: null }],
      },
      index.schemas.Catalog_X as (typeof index.schemas)[string],
      'Europe/Moscow',
      index,
      'date',
    )
    // Schema-less: a Date is found by value, in the server's zone; a null stays null.
    expect(out).toEqual({
      Дата: '2024-01-02T06:04:05',
      Битые: [{ Дата: '2024-01-02T06:04:05', Код: 'x' }],
      Вложенный: { Дата: '2024-01-02T06:04:05', Код: 'y' },
      Товары: [{ Дата: '2024-01-02T06:04:05', Сумма: null }],
    })
  })

  it('a tabular part typed by an inherited key has no row schema for any()/all()', () => {
    const G = '8af68945-1c2d-11ef-9b6a-00155d102d01'
    const q = new ODataV3Client({
      baseUrl: 'http://example.test/odata',
      auth: BasicAuth({ username: 'u', password: 'p' }),
      serverTimezone: 'UTC',
      metadataIndex: index,
    }).query<{ Товары: { Идентификатор: string }[]; Битые: { Идентификатор: string }[] }>('Catalog_X')
    // A row schema the index holds types Идентификатор as Edm.Guid; none leaves it a string.
    q.filter((f) => any(f.Товары, (t) => t.Идентификатор.eq(G)))
    expect(toFilterString(q.state.filter as FilterExpression)).toBe(`Товары/any(t0: t0/Идентификатор eq guid'${G}')`)
    q.filter((f) => any(f.Битые, (t) => t.Идентификатор.eq(G)))
    expect(toFilterString(q.state.filter as FilterExpression)).toBe(`Битые/any(t0: t0/Идентификатор eq '${G}')`)
  })
})

describe('the client over such an index', () => {
  const server = setupServer()
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  afterAll(() => server.close())
  beforeEach(() => server.resetHandlers())

  const client = new ODataV3Client({
    baseUrl: 'http://example.test/odata',
    auth: BasicAuth({ username: 'u', password: 'p' }),
    serverTimezone: 'UTC',
    metadataIndex: odd,
    validateOnWrite: true,
  })
  const G = '8af68945-1c2d-11ef-9b6a-00155d102d01'
  const wire = { Ref_Key: G, Сумма: '5' }

  it('reads a collection and an entity', async () => {
    server.use(
      http.get(/Catalog_X\(/, () => HttpResponse.json(wire)),
      http.get(/Catalog_X/, () => HttpResponse.json({ value: [wire] })),
    )
    await expect(client.query('Catalog_X').get()).resolves.toMatchObject({ value: [wire] })
    await expect(client.entity('Catalog_X', G).get()).resolves.toMatchObject(wire)
  })

  it('writes without validating against Object', async () => {
    let body: unknown
    server.use(
      http.post(/Catalog_X/, async ({ request }) => {
        body = await request.json()
        return HttpResponse.json(wire)
      }),
    )
    await expect(client.entity('Catalog_X').create({ Сумма: '5' })).resolves.toMatchObject(wire)
    expect(body).toEqual({ Сумма: '5' })
  })
})
