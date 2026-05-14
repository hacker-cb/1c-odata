import { describe, expect, it } from 'vitest'
import { emitFunctionImportsFile } from '../../../src/codegen/emitter/function-import.js'
import type { EdmxFunctionImport } from '../../../src/codegen/parser/ast.js'

const fis: EdmxFunctionImport[] = [
  {
    name: 'Post',
    httpMethod: 'POST',
    isBindable: true,
    entitySetPath: 'Document_РТУ',
    parameters: [{ name: 'PostingModeOperational', type: 'Edm.Boolean', nullable: true, mode: 'In' }],
  },
  {
    name: 'Unpost',
    httpMethod: 'POST',
    isBindable: true,
    entitySetPath: 'Document_РТУ',
    parameters: [],
  },
  {
    name: 'Balance',
    httpMethod: 'GET',
    isBindable: true,
    entitySetPath: 'AccumulationRegister_X',
    returnType: 'Collection(StandardODATA.AccumulationRegister_X_Balance)',
    parameters: [
      { name: 'Period', type: 'Edm.DateTime', nullable: true, mode: 'In' },
      { name: 'Condition', type: 'Edm.String', nullable: true, mode: 'In' },
      { name: 'Dimensions', type: 'Edm.String', nullable: true, mode: 'In' },
    ],
  },
]

describe('emitFunctionImportsFile', () => {
  it('emits one Functions interface with a key per EntitySet', () => {
    const out = emitFunctionImportsFile({
      fis,
      schemaNamespace: 'StandardODATA',
      int64Mode: 'string',
      dateMode: 'date',
    })
    expect(out).toContain('export interface Functions {')
    expect(out).toContain('Document_РТУ:')
    expect(out).toContain('AccumulationRegister_X:')
  })

  it('emits write FI signatures with Promise<void> return type', () => {
    const out = emitFunctionImportsFile({
      fis,
      schemaNamespace: 'StandardODATA',
      int64Mode: 'string',
      dateMode: 'date',
    })
    expect(out).toMatch(/Post\(args:[^)]*\): Promise<void>/)
    expect(out).toMatch(/Unpost\(args: \{\}\): Promise<void>/)
  })

  it('emits read FI signatures with mapped Promise<Return[]> from ReturnType', () => {
    const out = emitFunctionImportsFile({
      fis,
      schemaNamespace: 'StandardODATA',
      int64Mode: 'string',
      dateMode: 'date',
    })
    expect(out).toMatch(/Balance\(args:[^)]*\): Promise<AccumulationRegister_X_Balance\[\]>/)
  })

  it('marks nullable parameters as optional in the args type', () => {
    const out = emitFunctionImportsFile({
      fis,
      schemaNamespace: 'StandardODATA',
      int64Mode: 'string',
      dateMode: 'date',
    })
    expect(out).toContain('Period?: Date | null')
    expect(out).toContain('Condition?: string | null')
  })

  it('emits "export {}" when fis is empty', () => {
    const out = emitFunctionImportsFile({
      fis: [],
      schemaNamespace: 'StandardODATA',
      int64Mode: 'string',
      dateMode: 'date',
    })
    expect(out).toBe('export {}\n')
  })

  it('emits Edm.DateTime FI parameter as Date | null in dateMode=date', () => {
    const out = emitFunctionImportsFile({
      fis: [
        {
          name: 'Balance',
          httpMethod: 'GET',
          entitySetPath: 'AccumulationRegister_X',
          returnType: 'Collection(StandardODATA.AccumulationRegister_X_Balance)',
          parameters: [
            { name: 'bindingParameter', type: 'StandardODATA.AccumulationRegister_X', nullable: true },
            { name: 'Period', type: 'Edm.DateTime', nullable: false },
          ],
        },
      ],
      schemaNamespace: 'StandardODATA',
      int64Mode: 'number',
      dateMode: 'date',
    })
    // FI parameter Period non-nullable Edm.DateTime → emit as `Period?: Date | null`
    expect(out).toContain('Period?: Date | null')
  })

  it('emits Edm.DateTime FI return as Promise<Date | null> in dateMode=date', () => {
    const out = emitFunctionImportsFile({
      fis: [
        {
          name: 'GetNow',
          httpMethod: 'GET',
          entitySetPath: 'AccumulationRegister_X',
          returnType: 'Edm.DateTime',
          parameters: [{ name: 'bindingParameter', type: 'StandardODATA.AccumulationRegister_X', nullable: true }],
        },
      ],
      schemaNamespace: 'StandardODATA',
      int64Mode: 'number',
      dateMode: 'date',
    })
    expect(out).toContain('GetNow(args: {}): Promise<Date | null>')
  })

  it('emits Edm.DateTime FI return as Promise<string> in dateMode=string', () => {
    const out = emitFunctionImportsFile({
      fis: [
        {
          name: 'GetNow',
          httpMethod: 'GET',
          entitySetPath: 'X',
          returnType: 'Edm.DateTime',
          parameters: [{ name: 'bindingParameter', type: 'StandardODATA.X', nullable: true }],
        },
      ],
      schemaNamespace: 'StandardODATA',
      int64Mode: 'number',
      dateMode: 'string',
    })
    expect(out).toContain('GetNow(args: {}): Promise<string>')
  })
})
