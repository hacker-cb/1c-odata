import { describe, expect, it } from 'vitest'
import { emitComplexTypesFile } from '../../../src/codegen/emitter/complex.js'
import type { EdmxComplexType } from '../../../src/codegen/parser/ast.js'

const types: EdmxComplexType[] = [
  {
    name: 'TypeDescription',
    properties: [{ name: 'Types', type: 'Collection(Edm.String)', nullable: false }],
  },
  {
    name: 'NumberQualifiers',
    properties: [
      { name: 'Digits', type: 'Edm.Int32', nullable: false },
      { name: 'FractionDigits', type: 'Edm.Int32', nullable: false },
    ],
  },
]

describe('emitComplexTypesFile', () => {
  it('emits a single file with one interface per type', () => {
    const out = emitComplexTypesFile({
      types,
      schemaNamespace: 'StandardODATA',
      int64Mode: 'string',
      dateMode: 'date',
    })
    expect(out).toContain('export interface TypeDescription {')
    expect(out).toContain('Types: string[]')
    expect(out).toContain('export interface NumberQualifiers {')
    expect(out).toContain('Digits: number')
  })

  it('emits empty file body when no types are passed', () => {
    const out = emitComplexTypesFile({
      types: [],
      schemaNamespace: 'StandardODATA',
      int64Mode: 'string',
      dateMode: 'date',
    })
    expect(out).toBe('export {}\n')
  })

  it('does not import Guid from core when a property type only contains "Guid" as substring', () => {
    // Regression: a custom ComplexType named e.g. `MyGuidWrapper` must not trigger
    // the `import type { Guid } from '@1c-odata/client'` line via substring matching.
    const customTypes: EdmxComplexType[] = [
      {
        name: 'WrapperHolder',
        properties: [
          { name: 'SingleWrapper', type: 'StandardODATA.MyGuidWrapper', nullable: false },
          { name: 'WrapperList', type: 'Collection(StandardODATA.XGuid)', nullable: false },
        ],
      },
    ]
    const out = emitComplexTypesFile({
      types: customTypes,
      schemaNamespace: 'StandardODATA',
      int64Mode: 'string',
      dateMode: 'date',
    })
    expect(out).not.toContain("import type { Guid } from '@1c-odata/client'")
    expect(out).toContain('SingleWrapper: MyGuidWrapper')
    expect(out).toContain('WrapperList: XGuid[]')
  })

  it('emits nullable ComplexType property as `name?: T | null` (C7 fix — consistency with entity emitter)', () => {
    const out = emitComplexTypesFile({
      types: [
        {
          name: 'AccumulationRegister_X_Balance',
          properties: [
            { name: 'Сумма', type: 'Edm.Double', nullable: true },
            { name: 'Период', type: 'Edm.DateTime', nullable: true },
          ],
        },
      ],
      schemaNamespace: 'StandardODATA',
      int64Mode: 'number',
      dateMode: 'date',
    })
    // C7 — `?:` marker must be present for nullable, previously absent
    expect(out).toContain('Сумма?: number | null')
    expect(out).toContain('Период?: Date | null')
  })

  it('emits non-nullable ComplexType Edm.DateTime as Date | null in dateMode=date', () => {
    const out = emitComplexTypesFile({
      types: [
        {
          name: 'X_Balance',
          properties: [{ name: 'Period', type: 'Edm.DateTime', nullable: false }],
        },
      ],
      schemaNamespace: 'StandardODATA',
      int64Mode: 'number',
      dateMode: 'date',
    })
    expect(out).toContain('Period?: Date | null')
  })

  it('emits non-nullable ComplexType Edm.DateTime as `string` in dateMode=string', () => {
    const out = emitComplexTypesFile({
      types: [
        {
          name: 'X_Balance',
          properties: [{ name: 'Period', type: 'Edm.DateTime', nullable: false }],
        },
      ],
      schemaNamespace: 'StandardODATA',
      int64Mode: 'number',
      dateMode: 'string',
    })
    expect(out).toContain('Period: string')
    expect(out).not.toContain('Period?:')
  })
})
