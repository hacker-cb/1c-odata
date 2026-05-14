import { describe, expect, it } from 'vitest'
import { mapEdmxTypeToTs, type TypeMapperOptions } from '../../../src/codegen/emitter/type-mapper.js'

const baseOpts: TypeMapperOptions = {
  schemaNamespace: 'StandardODATA',
  int64Mode: 'string',
  dateMode: 'date',
}

describe('mapEdmxTypeToTs — primitives', () => {
  const cases: [string, string][] = [
    ['Edm.String', 'string'],
    ['Edm.Boolean', 'boolean'],
    ['Edm.Int16', 'number'],
    ['Edm.Int32', 'number'],
    ['Edm.Double', 'number'],
    ['Edm.Guid', 'Guid'],
    ['Edm.DateTime', 'Date'],
    ['Edm.Binary', 'string'],
    ['Edm.Stream', 'string'],
  ]
  for (const [edmx, ts] of cases) {
    it(`${edmx} → ${ts}`, () => {
      expect(mapEdmxTypeToTs(edmx, baseOpts)).toBe(ts)
    })
  }
})

describe('mapEdmxTypeToTs — Int64 options', () => {
  it('default → string', () => {
    expect(mapEdmxTypeToTs('Edm.Int64', { ...baseOpts, int64Mode: 'string' })).toBe('string')
  })
  it('number → number', () => {
    expect(mapEdmxTypeToTs('Edm.Int64', { ...baseOpts, int64Mode: 'number' })).toBe('number')
  })
  it('bigint → bigint', () => {
    expect(mapEdmxTypeToTs('Edm.Int64', { ...baseOpts, int64Mode: 'bigint' })).toBe('bigint')
  })
})

describe('mapEdmxTypeToTs — DateTime options', () => {
  it("dateMode='string' → string", () => {
    expect(mapEdmxTypeToTs('Edm.DateTime', { ...baseOpts, dateMode: 'string' })).toBe('string')
  })
})

describe('mapEdmxTypeToTs — Collection + custom types', () => {
  it('Collection(Edm.String) → string[]', () => {
    expect(mapEdmxTypeToTs('Collection(Edm.String)', baseOpts)).toBe('string[]')
  })
  it('Collection(StandardODATA.X_RowType) → X_RowType[]', () => {
    expect(mapEdmxTypeToTs('Collection(StandardODATA.X_RowType)', baseOpts)).toBe('X_RowType[]')
  })
  it('StandardODATA.TypeDescription → TypeDescription', () => {
    expect(mapEdmxTypeToTs('StandardODATA.TypeDescription', baseOpts)).toBe('TypeDescription')
  })
})

describe('mapEdmxTypeToTs — error handling', () => {
  it('throws on unrecognized Edm.* type', () => {
    expect(() => mapEdmxTypeToTs('Edm.Decimal', baseOpts)).toThrow(/Unmapped EDM type: "Edm.Decimal"/)
  })

  it('throws on Edm.* type outside whitelist (defensive — should be unreachable on real EDMX)', () => {
    expect(() => mapEdmxTypeToTs('Edm.Time', baseOpts)).toThrow(/Unmapped EDM type/)
    expect(() => mapEdmxTypeToTs('Edm.DateTimeOffset', baseOpts)).toThrow(/Unmapped EDM type/)
  })

  it('still resolves schema-namespaced types', () => {
    expect(mapEdmxTypeToTs('StandardODATA.MyCustomType', baseOpts)).toBe('MyCustomType')
  })
})
