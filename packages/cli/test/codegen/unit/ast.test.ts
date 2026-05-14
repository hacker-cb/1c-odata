import { describe, expect, it } from 'vitest'
import type {
  EdmxAssociation,
  EdmxComplexType,
  EdmxEntityContainer,
  EdmxEntitySet,
  EdmxEntityType,
  EdmxEnumType,
  EdmxFunctionImport,
  EdmxModel,
  EdmxNavigationProperty,
  EdmxParameter,
  EdmxProperty,
} from '../../../src/codegen/parser/ast.js'

describe('parser/ast type shape', () => {
  it('EdmxModel composes the documented child arrays', () => {
    const model: EdmxModel = {
      schemaNamespace: 'StandardODATA',
      entityTypes: [],
      complexTypes: [],
      enumTypes: [],
      associations: [],
      entityContainer: { name: 'StandardODATA', entitySets: [], functionImports: [] },
    }
    expect(model.schemaNamespace).toBe('StandardODATA')
  })

  it('EdmxEntityType holds key, properties, navProperties', () => {
    const e: EdmxEntityType = {
      name: 'Catalog_Валюты',
      key: ['Ref_Key'],
      properties: [
        { name: 'Ref_Key', type: 'Edm.Guid', nullable: false },
        { name: 'Code', type: 'Edm.String', nullable: false, maxLength: 3 },
      ],
      navigationProperties: [],
    }
    expect(e.key).toEqual(['Ref_Key'])
  })

  it('EdmxFunctionImport carries httpMethod + parameters + returnType', () => {
    const fi: EdmxFunctionImport = {
      name: 'Balance',
      httpMethod: 'GET',
      isBindable: true,
      parameters: [{ name: 'Period', type: 'Edm.DateTime', nullable: true, mode: 'In' }],
      returnType: 'Collection(StandardODATA.AccumulationRegister_X_Balance)',
      entitySetPath: 'AccumulationRegister_X',
    }
    expect(fi.httpMethod).toBe('GET')
  })

  // Smoke type-checks for the rest
  it('all sub-types are exported', () => {
    const _p: EdmxProperty = { name: 'x', type: 'Edm.String', nullable: true }
    const _np: EdmxNavigationProperty = {
      name: 'Контрагент',
      relationship: 'StandardODATA.Doc_Контрагент',
      fromRole: 'Source',
      toRole: 'Target',
    }
    const _ct: EdmxComplexType = { name: 'TypeDescription', properties: [] }
    const _en: EdmxEnumType = { name: 'X', underlyingType: 'Edm.Int32', members: [] }
    const _assoc: EdmxAssociation = {
      name: 'Doc_Контрагент',
      ends: [
        { role: 'Source', type: 'StandardODATA.Document_X', multiplicity: '*' },
        { role: 'Target', type: 'StandardODATA.Catalog_Контрагенты', multiplicity: '0..1' },
      ],
    }
    const _es: EdmxEntitySet = { name: 'Catalog_Валюты', entityType: 'StandardODATA.Catalog_Валюты' }
    const _ec: EdmxEntityContainer = { name: 'StandardODATA', entitySets: [], functionImports: [] }
    const _param: EdmxParameter = { name: 'Period', type: 'Edm.DateTime', nullable: true, mode: 'In' }
    expect(true).toBe(true)
  })
})
