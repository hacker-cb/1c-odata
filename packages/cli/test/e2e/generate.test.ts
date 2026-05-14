import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runGenerate } from '../../src/commands/generate.js'
import { createTmpProject } from './helpers.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')

describe('e2e: generate against committed snapshots/trade_v11.5.xml', () => {
  let project: ReturnType<typeof createTmpProject>

  beforeEach(() => {
    project = createTmpProject()
  })
  afterEach(() => {
    project.cleanup()
  })

  it('generates 2551+ files for the trade_v11.5 schema', async () => {
    mkdirSync(`${project.tmp}/metadata`, { recursive: true })
    copyFileSync(`${repoRoot}/snapshots/trade_v11.5.xml`, `${project.tmp}/metadata/trade_v11_5.xml`)

    await runGenerate({
      cwd: project.tmp,
      cliVersion: '0.0.0-test',
      config: {
        metadataDir: './metadata',
        generatedDir: './generated',
        connections: {
          trade_v11_5: {
            baseUrl: 'http://example.test/odata',
            auth: { username: 'u', password: 'p' },
            serverTimezone: 'Europe/Moscow',
          },
        },
      },
    })

    expect(existsSync(`${project.tmp}/generated/trade_v11_5/index.ts`)).toBe(true)
    expect(existsSync(`${project.tmp}/generated/trade_v11_5/__metadata.json`)).toBe(true)
    expect(existsSync(`${project.tmp}/generated/trade_v11_5/catalogs/index.ts`)).toBe(true)
    expect(existsSync(`${project.tmp}/generated/trade_v11_5/documents/index.ts`)).toBe(true)
    expect(existsSync(`${project.tmp}/generated/trade_v11_5/function-imports.ts`)).toBe(true)
  }, 60_000)

  it('respects per-connection codegen options (include filter)', async () => {
    mkdirSync(`${project.tmp}/metadata`, { recursive: true })
    copyFileSync(`${repoRoot}/snapshots/trade_v11.5.xml`, `${project.tmp}/metadata/trade.xml`)

    await runGenerate({
      cwd: project.tmp,
      cliVersion: '0.0.0-test',
      config: {
        connections: {
          trade: {
            baseUrl: 'http://example.test/odata',
            auth: { username: 'u', password: 'p' },
            serverTimezone: 'Europe/Moscow',
            codegen: { include: ['Catalog_*'] },
          },
        },
      },
    })

    expect(existsSync(`${project.tmp}/generated/trade/catalogs/index.ts`)).toBe(true)
    // Closure now pulls in Document_* entities referenced via Catalog_* NavProps,
    // so the documents index is non-empty when include: ['Catalog_*'] is used.
    const docsIndex = await import('node:fs').then((fs) =>
      fs.readFileSync(`${project.tmp}/generated/trade/documents/index.ts`, 'utf8'),
    )
    expect(docsIndex).not.toBe('export {}\n')
  }, 60_000)
})
