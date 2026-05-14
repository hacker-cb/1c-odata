import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ParseError } from '../../src/errors.js'
import { loadMetadataIndex } from '../../src/load-metadata-index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let tmp: string

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'load-meta-'))
})

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function writeJson(name: string, content: unknown): Promise<string> {
  const path = join(tmp, name)
  await writeFile(path, JSON.stringify(content), 'utf8')
  return path
}

describe('loadMetadataIndex', () => {
  it('loads a valid minimal index', async () => {
    const path = await writeJson('valid.json', {
      schemaNamespace: 'StandardODATA',
      schemas: {},
      entitySetToType: {},
    })
    const idx = await loadMetadataIndex(path)
    expect(idx.schemaNamespace).toBe('StandardODATA')
    expect(idx.schemas).toEqual({})
    expect(idx.entitySetToType).toEqual({})
  })

  it('loads an index with shape and enums', async () => {
    const path = await writeJson('full.json', {
      schemaNamespace: 'StandardODATA',
      schemas: {
        Catalog_X: {
          properties: { Code: { type: 'Edm.String', nullable: true, maxLength: 25 } },
        },
      },
      entitySetToType: { Catalog_X: 'Catalog_X' },
      shape: { int64Mode: 'number', dateMode: 'date' },
      enums: {
        СтатусыВнутреннихЗаказов: {
          underlyingType: 'Edm.Int32',
          members: [{ name: 'Закрыт' }, { name: 'КВыполнению' }],
        },
      },
    })
    const idx = await loadMetadataIndex(path)
    expect(idx.shape?.dateMode).toBe('date')
    expect(idx.enums?.СтатусыВнутреннихЗаказов?.members[0]?.name).toBe('Закрыт')
  })

  it('accepts URL input', async () => {
    const path = await writeJson('url.json', {
      schemaNamespace: 'StandardODATA',
      schemas: {},
      entitySetToType: {},
    })
    const idx = await loadMetadataIndex(pathToFileURL(path))
    expect(idx.schemaNamespace).toBe('StandardODATA')
  })

  it('throws ParseError on bad JSON', async () => {
    const path = join(tmp, 'bad.json')
    await writeFile(path, '{not valid json', 'utf8')
    await expect(loadMetadataIndex(path)).rejects.toThrow(ParseError)
    await expect(loadMetadataIndex(path)).rejects.toThrow(/Invalid JSON/)
  })

  it('throws ParseError with breadcrumb on missing schemaNamespace', async () => {
    const path = await writeJson('missing-ns.json', { schemas: {}, entitySetToType: {} })
    await expect(loadMetadataIndex(path)).rejects.toThrow(/\$\.schemaNamespace/)
    await expect(loadMetadataIndex(path)).rejects.toThrow(/Invalid metadata at /)
  })

  it('accepts partial shape (only int64Mode)', async () => {
    const path = await writeJson('partial-shape-1.json', {
      schemaNamespace: 'X',
      schemas: {},
      entitySetToType: {},
      shape: { int64Mode: 'bigint' },
    })
    const idx = await loadMetadataIndex(path)
    expect(idx.shape?.int64Mode).toBe('bigint')
    expect(idx.shape?.dateMode).toBeUndefined()
  })

  it('accepts empty shape {}', async () => {
    const path = await writeJson('empty-shape.json', {
      schemaNamespace: 'X',
      schemas: {},
      entitySetToType: {},
      shape: {},
    })
    const idx = await loadMetadataIndex(path)
    expect(idx.shape).toEqual({})
  })

  it('throws ParseError on non-string property.type', async () => {
    const path = await writeJson('bad-prop.json', {
      schemaNamespace: 'X',
      schemas: { E: { properties: { F: { type: 123, nullable: true } } } },
      entitySetToType: {},
    })
    await expect(loadMetadataIndex(path)).rejects.toThrow(/properties\.F\.type/)
  })

  it('throws ParseError on bad enum shape (members not array)', async () => {
    const path = await writeJson('bad-enum.json', {
      schemaNamespace: 'X',
      schemas: {},
      entitySetToType: {},
      enums: { E: { underlyingType: 'Edm.Int32', members: 'not-array' } },
    })
    await expect(loadMetadataIndex(path)).rejects.toThrow(/enums\.E\.members/)
  })

  it('throws ParseError on file not found', async () => {
    await expect(loadMetadataIndex(join(tmp, 'does-not-exist.json'))).rejects.toThrow(ParseError)
  })

  // `examples/basic/generated/` is .gitignored. On CI this assertion runs in
  // the `test-and-build` job, which does NOT generate the artefact (the
  // `Generate example types` step only lives in `test-live` for the
  // enum-roundtrip live test). So on CI this is silently skipped via the
  // `skipIf` below; it exercises real metadata only locally after the
  // developer runs `pnpm -F basic-example generate`. Adding generate to the
  // always-on unit path is an intentional non-fix — the seconds it adds to
  // every PR outweigh the one extra assertion's CI coverage.
  const realMetadataPath = join(__dirname, '../../../../examples/basic/generated/default/__metadata.json')
  it.skipIf(!existsSync(realMetadataPath))('integration: loads real examples/basic generated metadata', async () => {
    const idx = await loadMetadataIndex(realMetadataPath)
    expect(idx.schemaNamespace).toBe('StandardODATA')
    expect(Object.keys(idx.schemas).length).toBeGreaterThan(100)
    expect(idx.enums).toBeDefined() // After C-2: enums is @public again
  })
})
