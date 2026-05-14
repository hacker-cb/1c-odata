import { describe, expect, it } from 'vitest'
import { detectValueStorage } from '../../../src/codegen/analysis/value-storage.js'
import type { EdmxEntityType } from '../../../src/codegen/parser/ast.js'

const entity: EdmxEntityType = {
  name: 'Catalog_Файлы',
  key: ['Ref_Key'],
  properties: [
    { name: 'Ref_Key', type: 'Edm.Guid', nullable: false },
    { name: 'ФайлХранилище', type: 'Edm.Stream', nullable: true },
    { name: 'ФайлХранилище_Base64Data', type: 'Edm.Binary', nullable: true },
    { name: 'ФайлХранилище_Type', type: 'Edm.String', nullable: true },
    { name: 'НеХранилище', type: 'Edm.Stream', nullable: true },
    { name: 'Recorder', type: 'Edm.String', nullable: false },
    { name: 'Recorder_Type', type: 'Edm.String', nullable: false },
  ],
  navigationProperties: [],
}

describe('detectValueStorage', () => {
  it('returns base names where all 3 properties (<X> Stream + <X>_Base64Data Binary + <X>_Type String) exist', () => {
    expect(detectValueStorage(entity)).toEqual(new Set(['ФайлХранилище']))
  })

  it('does not pick up Stream-only fields (НеХранилище has no Base64Data + Type companions)', () => {
    expect(detectValueStorage(entity).has('НеХранилище')).toBe(false)
  })

  it('does not pick up Edm.String fields (Recorder pair has Edm.String type, not Edm.Stream)', () => {
    expect(detectValueStorage(entity).has('Recorder')).toBe(false)
  })
})
