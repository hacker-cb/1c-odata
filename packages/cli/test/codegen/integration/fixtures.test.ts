import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { generate } from '../../../src/codegen/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = resolve(here, '../fixtures')
const fixtures = readdirSync(fixturesDir)
  .filter((n) => n.endsWith('.xml'))
  .sort()

describe('integration: synthetic XML fixtures', () => {
  for (const fileName of fixtures) {
    it(`generates without throwing — ${fileName}`, () => {
      const xml = readFileSync(join(fixturesDir, fileName), 'utf8')
      const result = generate({ metadata: xml })
      expect(result.files.has('index.ts')).toBe(true)
      expect(result.files.has('__metadata.json')).toBe(true)
      // Every kind/index.ts is always emitted (consistency rule)
      expect(result.files.has('catalogs/index.ts')).toBe(true)
      expect(result.files.has('accounting-registers/index.ts')).toBe(true)
    })
  }

  it('01-catalog-with-table — emits parent file with nested tabular interface', () => {
    const xml = readFileSync(join(fixturesDir, '01-catalog-with-table.xml'), 'utf8')
    const result = generate({ metadata: xml })
    const file = result.files.get('catalogs/Номенклатура.ts')!
    expect(file).toContain('export interface Catalog_Номенклатура extends Entity {')
    expect(file).toContain('export interface Catalog_Номенклатура_Артикулы {')
    expect(file).toContain('Артикулы: Catalog_Номенклатура_Артикулы[]')
    // Tabular ComplexType (`_RowType`) is NOT emitted to complex-types.ts
    expect(result.files.has('complex-types.ts')).toBe(false)
  })

  it('02-document-with-fi — emits Functions interface with Document_РТУ.Post/Unpost', () => {
    const xml = readFileSync(join(fixturesDir, '02-document-with-fi.xml'), 'utf8')
    const result = generate({ metadata: xml })
    const fi = result.files.get('function-imports.ts')!
    expect(fi).toContain('Document_РТУ:')
    expect(fi).toMatch(/Post\(args:[^)]*\): Promise<void>/)
    expect(fi).toMatch(/Unpost\(args: \{\}\): Promise<void>/)
    const doc = result.files.get('documents/РТУ.ts')!
    expect(doc).toContain('Контрагент?: Catalog_Контрагенты')
  })

  it('06-value-storage — groups Stream + Base64Data + Type triple into ValueStorage', () => {
    const xml = readFileSync(join(fixturesDir, '06-value-storage.xml'), 'utf8')
    const result = generate({ metadata: xml })
    const file = result.files.get('catalogs/Файлы.ts')!
    expect(file).toContain('ФайлХранилище?: ValueStorage | null')
    expect(file).not.toContain('ФайлХранилище_Base64Data')
    expect(file).not.toContain('ФайлХранилище_Type')
  })

  it('07-composite-ref — emits Recorder + Recorder_Type as flat required string fields (Nullable="false")', () => {
    const xml = readFileSync(join(fixturesDir, '07-composite-ref.xml'), 'utf8')
    const result = generate({ metadata: xml })
    const file = result.files.get('accumulation-registers/X.ts')!
    expect(file).toContain('Recorder: string\n')
    expect(file).toContain('Recorder_Type: string\n')
  })

  it('08-constant — emits SurrogateKey shape with optional Value nav', () => {
    const xml = readFileSync(join(fixturesDir, '08-constant.xml'), 'utf8')
    const result = generate({ metadata: xml })
    const file = result.files.get('constants/ОсновнаяВалюта.ts')!
    expect(file).toContain('export interface Constant_ОсновнаяВалюта {')
    expect(file).toContain('SurrogateKey: number')
    expect(file).toContain('Value?: Catalog_Валюты')
    expect(file).not.toContain('extends Entity')
  })

  it('09-enum-and-complex — emits TypeDescription + NumberQualifiers, skips EnumType by default', () => {
    const xml = readFileSync(join(fixturesDir, '09-enum-and-complex.xml'), 'utf8')
    const result = generate({ metadata: xml })
    const ct = result.files.get('complex-types.ts')!
    expect(ct).toContain('export interface TypeDescription {')
    expect(ct).toContain('export interface NumberQualifiers {')
    // EnumType is NOT emitted (unbound enum emission deferred to Phase 7 — see spec §5.3)
    expect(ct).not.toContain('ВидНоменклатуры')
  })
})
