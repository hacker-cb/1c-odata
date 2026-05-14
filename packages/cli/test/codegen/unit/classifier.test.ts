import { describe, expect, it } from 'vitest'
import { classifyEntity, KIND_ORDER, KIND_TO_FOLDER, type Kind } from '../../../src/codegen/parser/classifier.js'

describe('classifier', () => {
  it('maps each prefix to its expected kind', () => {
    const cases: [string, Kind][] = [
      ['Catalog_Валюты', 'catalog'],
      ['Constant_Имя', 'constant'],
      ['Document_РТУ', 'document'],
      ['InformationRegister_X', 'information-register'],
      ['AccumulationRegister_Y', 'accumulation-register'],
      ['ExchangePlan_Z', 'exchange-plan'],
      ['ChartOfCharacteristicTypes_W', 'chart-of-characteristic-types'],
      ['DocumentJournal_J', 'document-journal'],
      ['BusinessProcess_P', 'business-process'],
      ['Task_T', 'task'],
      ['ChartOfAccounts_A', 'chart-of-accounts'],
      ['ChartOfCalculationTypes_C', 'chart-of-calculation-types'],
      ['CalculationRegister_R', 'calculation-register'],
      ['AccountingRegister_X', 'accounting-register'],
    ]
    for (const [name, kind] of cases) expect(classifyEntity(name)).toBe(kind)
  })

  it('returns null for entities that do not match any of the 14 prefixes', () => {
    expect(classifyEntity('Document_РТУ_Товары')).toBe('document') // tabular still matches by prefix
    expect(classifyEntity('Foo_Bar')).toBe(null)
    expect(classifyEntity('NoUnderscore')).toBe(null)
  })

  it('exposes KIND_ORDER and KIND_TO_FOLDER for all 14 kinds', () => {
    expect(KIND_ORDER).toHaveLength(14)
    expect(KIND_TO_FOLDER.catalog).toBe('catalogs')
    expect(KIND_TO_FOLDER['accounting-register']).toBe('accounting-registers')
  })
})
