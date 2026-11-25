import { runInNewContext } from 'node:vm'
import { BasicAuth, InvalidArgumentError, ODataV3Client, type TurnoversArgs } from '@1c-odata/client'
import { HttpResponse, http } from 'msw'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildFunctionUrl } from '../../src/functions.js'
import { compileFilter } from '../../src/query/filter-internal.js'
import { buildV3KeyUrl, formatScalarLiteral, isDate } from '../../src/url-builder.js'
import type { EntitySchema, MetadataIndex } from '../../src/validate.js'
import { transformDatesToWire, transformDateValuesUntyped } from '../../src/write-transform.js'
import { createMswServer } from '../fixtures/msw-server.js'

const TZ = 'Europe/Moscow'
const base = 'http://1c.test/odata/standard.odata'

/** 2025-01-15 07:30 UTC = 10:30 in Moscow — a `Date` of another realm, where `instanceof Date` is false. */
const foreign = (): Date => runInNewContext('new Date(Date.UTC(2025, 0, 15, 7, 30))') as Date
const WALL = '2025-01-15T10:30:00'

describe('a Date of another realm (node:vm) (#205)', () => {
  it('is not an instanceof Date here — the case under test', () => {
    expect(foreign() instanceof Date).toBe(false)
    expect(isDate(foreign())).toBe(true)
  })

  it('isDate: false for what only looks like a Date', () => {
    expect(isDate({ getTime: () => 0 })).toBe(false)
    expect(isDate('2025-01-15T10:30:00')).toBe(false)
    expect(isDate(0)).toBe(false)
    expect(isDate(null)).toBe(false)
  })

  it('formatScalarLiteral writes it in the server timezone', () => {
    expect(formatScalarLiteral(foreign(), TZ, 'x')).toBe(`datetime'${WALL}'`)
  })

  it('formatScalarLiteral: the scalars by JS type, undefined for the rest', () => {
    expect(formatScalarLiteral("O'Brien", TZ, 'x')).toBe("'O''Brien'")
    expect(formatScalarLiteral(true, TZ, 'x')).toBe('true')
    expect(formatScalarLiteral(1e-7, TZ, 'x')).toBe('0.0000001')
    expect(formatScalarLiteral(12n, TZ, 'x')).toBe('12')
    expect(formatScalarLiteral(null, TZ, 'x')).toBeUndefined()
    expect(formatScalarLiteral({}, TZ, 'x')).toBeUndefined()
    expect(() => formatScalarLiteral(Number.NaN, TZ, 'x')).toThrow(InvalidArgumentError)
    expect(() => formatScalarLiteral(new Date(Number.NaN), TZ, 'x')).toThrow(InvalidArgumentError)
  })

  it('filter literal: datetime in the server timezone, not String(v)', () => {
    const d = foreign()
    expect(compileFilter<{ Date: Date }>(TZ, (f) => f.Date.eq(d))).toBe(`Date eq datetime'${WALL}'`)
  })

  it('function-import argument: datetime in the server timezone', () => {
    const url = buildFunctionUrl(base, 'AccumulationRegister_X', 'Balance', {}, { Period: foreign() }, TZ)
    expect(decodeURIComponent(url)).toContain(`Period=datetime'${WALL}'`)
  })

  it('composite key: datetime in the server timezone', () => {
    const url = buildV3KeyUrl(base, 'InformationRegister_X', { Period: foreign() }, TZ)
    expect(url).toContain(`(Period=datetime'${WALL}')`)
  })

  it('write without a schema: naive ISO in the server timezone, nested too', () => {
    expect(transformDateValuesUntyped(foreign(), TZ)).toBe(WALL)
    expect(transformDateValuesUntyped({ Rows: [{ Date: foreign() }] }, TZ)).toEqual({ Rows: [{ Date: WALL }] })
  })

  it('write with a schema: an Edm.DateTime field in the server timezone', () => {
    const schema: EntitySchema = { properties: { Date: { type: 'Edm.DateTime', nullable: true } } }
    const index: MetadataIndex = {
      schemaNamespace: 'StandardODATA',
      schemas: { Document_X: schema },
      entitySetToType: { Document_X: 'Document_X' },
      shape: { dateMode: 'date', int64Mode: 'number' },
    }
    expect(transformDatesToWire({ Date: foreign() }, schema, TZ, index, 'date').Date).toBe(WALL)
  })
})

describe('a Date of another realm through the client (#205)', () => {
  const server = createMswServer()
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())
  const client = () =>
    new ODataV3Client({ baseUrl: base, auth: BasicAuth({ username: 'u', password: 'p' }), serverTimezone: TZ })

  it('create() sends it as naive server time, not ISO with Z', async () => {
    let sent: unknown
    server.use(
      http.post(`${base}/Document_X`, async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json({ Ref_Key: '11111111-2222-3333-4444-555555555555' }, { status: 201 })
      }),
    )
    await client().entity('Document_X').create({ Date: foreign() })
    expect(sent).toEqual({ Date: WALL })
  })

  it('turnovers() rejects it as a point period, as it does a Date of this realm', async () => {
    const args = { Period: foreign() } as unknown as TurnoversArgs
    await expect(client().register('AccumulationRegister_X').turnovers(args)).rejects.toThrow(InvalidArgumentError)
  })
})
