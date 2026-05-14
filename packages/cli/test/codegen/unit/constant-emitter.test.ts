import { describe, expect, it } from 'vitest'
import { emitConstantFile } from '../../../src/codegen/emitter/constant.js'
import type { EdmxEntityType } from '../../../src/codegen/parser/ast.js'

const constant: EdmxEntityType = {
  name: 'Constant_ОсновнаяВалюта',
  key: ['SurrogateKey'],
  properties: [
    { name: 'SurrogateKey', type: 'Edm.Int32', nullable: false },
    { name: 'Value_Key', type: 'Edm.Guid', nullable: true },
  ],
  navigationProperties: [
    {
      name: 'Value',
      relationship: 'StandardODATA.Const_Value',
      fromRole: 'Source',
      toRole: 'Target',
      resolvedTargetType: 'StandardODATA.Catalog_Валюты',
    },
  ],
}

describe('emitConstantFile', () => {
  it('emits the SurrogateKey + Value_Key shape with optional expanded Value nav', () => {
    const out = emitConstantFile({
      entity: constant,
      schemaNamespace: 'StandardODATA',
      int64Mode: 'string',
      dateMode: 'date',
    })
    expect(out).toContain('export interface Constant_ОсновнаяВалюта {')
    expect(out).toContain('SurrogateKey: number')
    expect(out).toContain('Value_Key?: Guid | null')
    expect(out).toContain('Value?: Catalog_Валюты | null')
    expect(out).not.toContain('extends Entity')
  })

  it('emits non-nullable Edm.DateTime in Constant as Date | null in dateMode=date', () => {
    const out = emitConstantFile({
      entity: {
        name: 'Constant_ДатаОткрытияПериода',
        key: [],
        properties: [{ name: 'Value', type: 'Edm.DateTime', nullable: false }],
        navigationProperties: [],
      },
      schemaNamespace: 'StandardODATA',
      int64Mode: 'number',
      dateMode: 'date',
    })
    expect(out).toContain('Value?: Date | null')
  })
})
