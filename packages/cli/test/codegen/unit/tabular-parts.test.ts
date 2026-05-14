import { describe, expect, it } from 'vitest'
import { linkTabularParts } from '../../../src/codegen/analysis/tabular-parts.js'
import type { EdmxEntityType } from '../../../src/codegen/parser/ast.js'

describe('linkTabularParts', () => {
  it('groups <Header>_<Tabular> entities under their parent header', () => {
    const entities: EdmxEntityType[] = [
      { name: 'Document_РТУ', key: ['Ref_Key'], properties: [], navigationProperties: [] },
      { name: 'Document_РТУ_Товары', key: ['Ref_Key', 'LineNumber'], properties: [], navigationProperties: [] },
      { name: 'Document_РТУ_Услуги', key: ['Ref_Key', 'LineNumber'], properties: [], navigationProperties: [] },
      { name: 'Document_Заказ', key: ['Ref_Key'], properties: [], navigationProperties: [] },
    ]
    const { headerToTabulars, tabularToHeader } = linkTabularParts(entities)
    expect(headerToTabulars.get('Document_РТУ')).toEqual(['Document_РТУ_Товары', 'Document_РТУ_Услуги'])
    expect(tabularToHeader.get('Document_РТУ_Товары')).toBe('Document_РТУ')
    expect(headerToTabulars.has('Document_Заказ')).toBe(false)
  })

  it('treats AccumulationRegister_X_RecordType as a tabular part of AccumulationRegister_X', () => {
    // Real 1С EDMX shape (verified against snapshots/trade_v11.5.xml):
    //   parent     key = ["Recorder", "Recorder_Type"]
    //   _RecordType key = ["Recorder", "LineNumber", "Recorder_Type"]
    const entities: EdmxEntityType[] = [
      {
        name: 'AccumulationRegister_X',
        key: ['Recorder', 'Recorder_Type'],
        properties: [],
        navigationProperties: [],
      },
      {
        name: 'AccumulationRegister_X_RecordType',
        key: ['Recorder', 'LineNumber', 'Recorder_Type'],
        properties: [],
        navigationProperties: [],
      },
    ]
    const { headerToTabulars, tabularToHeader } = linkTabularParts(entities)
    expect(headerToTabulars.get('AccumulationRegister_X')).toEqual(['AccumulationRegister_X_RecordType'])
    expect(tabularToHeader.get('AccumulationRegister_X_RecordType')).toBe('AccumulationRegister_X')
  })

  it('links _RecordType to parent regardless of key shape — both ends may have any key length', () => {
    // Real IR shape: parent and _RecordType BOTH have key length 2 (different shapes).
    // The link must not depend on key-length comparison — name match is enough.
    const entities: EdmxEntityType[] = [
      {
        name: 'InformationRegister_Y',
        key: ['Recorder', 'Recorder_Type'],
        properties: [],
        navigationProperties: [],
      },
      {
        name: 'InformationRegister_Y_RecordType',
        key: ['Period', 'Контрагент_Key'],
        properties: [],
        navigationProperties: [],
      },
    ]
    const { headerToTabulars, tabularToHeader } = linkTabularParts(entities)
    expect(headerToTabulars.get('InformationRegister_Y')).toEqual(['InformationRegister_Y_RecordType'])
    expect(tabularToHeader.get('InformationRegister_Y_RecordType')).toBe('InformationRegister_Y')
  })

  it('does not link a _RecordType when its parent name is not a known EntityType', () => {
    const entities: EdmxEntityType[] = [
      {
        name: 'AccumulationRegister_Orphan_RecordType',
        key: ['Recorder', 'LineNumber'],
        properties: [],
        navigationProperties: [],
      },
    ]
    const { headerToTabulars, tabularToHeader } = linkTabularParts(entities)
    expect(headerToTabulars.size).toBe(0)
    expect(tabularToHeader.size).toBe(0)
  })

  it('ignores entities whose key is single Ref_Key — those are headers, not tabulars', () => {
    const entities: EdmxEntityType[] = [
      { name: 'Document_РТУ', key: ['Ref_Key'], properties: [], navigationProperties: [] },
      // singleton key, even though its name has _Suffix — it's not a tabular part
      { name: 'Document_РТУ_NotATable', key: ['Ref_Key'], properties: [], navigationProperties: [] },
    ]
    const { headerToTabulars } = linkTabularParts(entities)
    expect(headerToTabulars.has('Document_РТУ')).toBe(false)
  })
})
