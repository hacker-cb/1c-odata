import { describe, expect, it } from 'vitest'
import { computeClosure } from '../../../src/codegen/analysis/closure.js'
import type { EdmxModel } from '../../../src/codegen/parser/ast.js'

const minimalModel: EdmxModel = {
  schemaNamespace: 'StandardODATA',
  entityTypes: [
    {
      name: 'Catalog_X',
      key: ['Ref_Key'],
      properties: [{ name: 'Ref_Key', type: 'Edm.Guid', nullable: false }],
      navigationProperties: [
        {
          name: 'Контрагент',
          relationship: '',
          fromRole: '',
          toRole: '',
          resolvedTargetType: 'StandardODATA.Catalog_Контрагенты',
        },
      ],
    },
    {
      name: 'Catalog_Контрагенты',
      key: ['Ref_Key'],
      properties: [{ name: 'Ref_Key', type: 'Edm.Guid', nullable: false }],
      navigationProperties: [],
    },
    {
      name: 'Catalog_Unrelated',
      key: ['Ref_Key'],
      properties: [{ name: 'Ref_Key', type: 'Edm.Guid', nullable: false }],
      navigationProperties: [],
    },
  ],
  complexTypes: [],
  enumTypes: [],
  associations: [],
  entityContainer: { name: 'C', entitySets: [], functionImports: [] },
}

describe('computeClosure', () => {
  it('returns full set when seed is everything', () => {
    const result = computeClosure(minimalModel, () => true)
    expect(result.entities.size).toBe(3)
  })

  it('expands to NavProp target', () => {
    const result = computeClosure(minimalModel, (n) => n === 'Catalog_X')
    expect(result.entities.has('Catalog_X')).toBe(true)
    expect(result.entities.has('Catalog_Контрагенты')).toBe(true)
    expect(result.entities.has('Catalog_Unrelated')).toBe(false)
    expect(result.additions.find((a) => a.name === 'Catalog_Контрагенты')?.reason).toMatch(/Catalog_X\.Контрагент/)
  })

  it('pulls tabular children', () => {
    const model: EdmxModel = {
      ...minimalModel,
      entityTypes: [
        { name: 'Document_РТУ', key: ['Ref_Key'], properties: [], navigationProperties: [] },
        {
          name: 'Document_РТУ_Товары',
          key: ['Ref_Key', 'LineNumber'],
          properties: [],
          navigationProperties: [],
        },
      ],
    }
    const r = computeClosure(model, (n) => n === 'Document_РТУ')
    expect(r.entities.has('Document_РТУ_Товары')).toBe(true)
  })

  it('pulls _RecordType companion', () => {
    const model: EdmxModel = {
      ...minimalModel,
      entityTypes: [
        { name: 'AR_X', key: ['Recorder', 'Recorder_Type'], properties: [], navigationProperties: [] },
        { name: 'AR_X_RecordType', key: ['Recorder', 'LineNumber'], properties: [], navigationProperties: [] },
      ],
    }
    const r = computeClosure(model, (n) => n === 'AR_X')
    expect(r.entities.has('AR_X_RecordType')).toBe(true)
  })

  it('pulls ComplexType referenced by Property', () => {
    const model: EdmxModel = {
      ...minimalModel,
      entityTypes: [
        {
          name: 'Catalog_X',
          key: ['Ref_Key'],
          properties: [
            { name: 'Ref_Key', type: 'Edm.Guid', nullable: false },
            { name: 'Тип', type: 'StandardODATA.TypeDescription', nullable: false },
          ],
          navigationProperties: [],
        },
      ],
      complexTypes: [
        { name: 'TypeDescription', properties: [{ name: 'Types', type: 'Collection(Edm.String)', nullable: false }] },
      ],
    }
    const r = computeClosure(model, (n) => n === 'Catalog_X')
    expect(r.complexTypes.has('TypeDescription')).toBe(true)
  })

  it('pulls FunctionImport bound to kept EntitySet, plus its return ComplexType', () => {
    const model: EdmxModel = {
      ...minimalModel,
      entityTypes: [{ name: 'AR_X', key: ['Recorder', 'Recorder_Type'], properties: [], navigationProperties: [] }],
      complexTypes: [{ name: 'AR_X_Balance', properties: [] }],
      entityContainer: {
        name: 'C',
        entitySets: [{ name: 'AR_X', entityType: 'StandardODATA.AR_X' }],
        functionImports: [
          {
            name: 'Balance',
            httpMethod: 'GET',
            entitySetPath: 'AR_X',
            returnType: 'Collection(StandardODATA.AR_X_Balance)',
            parameters: [],
          },
        ],
      },
    }
    const r = computeClosure(model, (n) => n === 'AR_X')
    expect(r.complexTypes.has('AR_X_Balance')).toBe(true)
    expect(r.functionImports.length).toBe(1)
  })

  it('reports closure additions in trace', () => {
    const r = computeClosure(minimalModel, (n) => n === 'Catalog_X')
    expect(r.additions).toContainEqual(expect.objectContaining({ name: 'Catalog_Контрагенты', kind: 'entity' }))
  })
})
