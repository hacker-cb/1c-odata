import { describe, expect, it } from 'vitest'
import { emitKindIndex, emitMasterIndex } from '../../../src/codegen/emitter/index-emitter.js'

describe('emitKindIndex', () => {
  it('emits empty re-export when no files', () => {
    expect(emitKindIndex([])).toBe('export {}\n')
  })

  it('emits sorted re-exports by tail name', () => {
    const out = emitKindIndex(['Валюты', 'Номенклатура', 'Контрагенты'])
    expect(out).toBe(
      `export * from './Валюты.js'\nexport * from './Контрагенты.js'\nexport * from './Номенклатура.js'\n`,
    )
  })
})

describe('emitMasterIndex', () => {
  it('emits export-* for every populated kind folder + complex-types + function-imports', () => {
    const out = emitMasterIndex({
      populatedKinds: ['catalogs', 'documents'],
      hasComplexTypes: true,
      hasFunctionImports: true,
      hasEnums: false,
    })
    expect(out).toContain(`export * from './catalogs/index.js'`)
    expect(out).toContain(`export * from './documents/index.js'`)
    expect(out).toContain(`export * from './complex-types.js'`)
    expect(out).toContain(`export type { Functions } from './function-imports.js'`)
  })

  it('omits Functions re-export when none', () => {
    const out = emitMasterIndex({
      populatedKinds: ['catalogs'],
      hasComplexTypes: false,
      hasFunctionImports: false,
      hasEnums: false,
    })
    expect(out).not.toContain('function-imports')
    expect(out).not.toContain('complex-types')
  })
})
