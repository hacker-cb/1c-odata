import { describe, expect, it } from 'vitest'
import { groupFunctionImportsByEntitySet } from '../../../src/codegen/analysis/function-bindings.js'
import type { EdmxFunctionImport } from '../../../src/codegen/parser/ast.js'

describe('groupFunctionImportsByEntitySet', () => {
  it('groups FIs by their entitySetPath; keeps unbound FIs under "" key', () => {
    const fis: EdmxFunctionImport[] = [
      { name: 'Post', httpMethod: 'POST', entitySetPath: 'Document_РТУ', parameters: [] },
      { name: 'Unpost', httpMethod: 'POST', entitySetPath: 'Document_РТУ', parameters: [] },
      { name: 'Balance', httpMethod: 'GET', entitySetPath: 'AR_X', parameters: [] },
      { name: 'Unbound', httpMethod: 'GET', parameters: [] },
    ]
    const grouped = groupFunctionImportsByEntitySet(fis)
    expect(grouped.get('Document_РТУ')?.map((f) => f.name)).toEqual(['Post', 'Unpost'])
    expect(grouped.get('AR_X')?.map((f) => f.name)).toEqual(['Balance'])
    expect(grouped.get('')?.map((f) => f.name)).toEqual(['Unbound'])
  })
})
