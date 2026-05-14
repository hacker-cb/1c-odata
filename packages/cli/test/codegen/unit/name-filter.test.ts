import { describe, expect, it } from 'vitest'
import { buildNameFilter } from '../../../src/codegen/name-filter.js'

describe('buildNameFilter', () => {
  it('passes everything when include is empty/unset', () => {
    expect(buildNameFilter({})('Catalog_Валюты')).toBe(true)
    expect(buildNameFilter({ include: [] })('Catalog_Валюты')).toBe(true)
  })

  it('with `include` — keeps matches', () => {
    const f = buildNameFilter({ include: ['Catalog_*', 'Document_*'] })
    expect(f('Catalog_Валюты')).toBe(true)
    expect(f('Document_РТУ')).toBe(true)
    expect(f('InformationRegister_X')).toBe(false)
  })
})
