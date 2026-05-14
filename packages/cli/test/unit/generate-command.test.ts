import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runGenerate } from '../../src/commands/generate.js'
import { writeOneFile } from '../../src/writer.js'

let tmp: string

const MIN_EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <EntityType Name="Catalog_Валюты">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
        <Property Name="Code" Type="Edm.String" Nullable="false" MaxLength="3"/>
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), '1c-odata-gen-cmd-'))
})
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe('runGenerate', () => {
  it('reads <metadataDir>/<conn>.xml and writes generated/<conn>/<files>', async () => {
    await writeOneFile(join(tmp, 'metadata/x.xml'), MIN_EDMX)
    await runGenerate({
      cwd: tmp,
      cliVersion: '0.0.0-test',
      config: {
        metadataDir: './metadata',
        generatedDir: './generated',
        connections: {
          x: {
            baseUrl: 'http://example.test/odata',
            auth: { username: 'u', password: 'p' },
            serverTimezone: 'Europe/Moscow',
          },
        },
      },
    })
    expect(existsSync(join(tmp, 'generated/x/index.ts'))).toBe(true)
    expect(existsSync(join(tmp, 'generated/x/__metadata.json'))).toBe(true)
    expect(existsSync(join(tmp, 'generated/x/catalogs/Валюты.ts'))).toBe(true)
    const file = readFileSync(join(tmp, 'generated/x/catalogs/Валюты.ts'), 'utf8')
    expect(file).toContain('export interface Catalog_Валюты extends Entity {')
  })

  it('passes per-connection codegen options through (shape.int64Mode)', async () => {
    await writeOneFile(join(tmp, 'metadata/x.xml'), MIN_EDMX)
    await runGenerate({
      cwd: tmp,
      cliVersion: '0.0.0-test',
      config: {
        connections: {
          x: {
            baseUrl: 'http://example.test/odata',
            auth: { username: 'u', password: 'p' },
            serverTimezone: 'Europe/Moscow',
            shape: { int64Mode: 'bigint' },
          },
        },
      },
    })
    expect(existsSync(join(tmp, 'generated/x/index.ts'))).toBe(true)
  })

  it('throws helpful error when metadata file is missing', async () => {
    await expect(
      runGenerate({
        cwd: tmp,
        cliVersion: '0.0.0-test',
        config: {
          connections: {
            x: {
              baseUrl: 'http://example.test/odata',
              auth: { username: 'u', password: 'p' },
              serverTimezone: 'Europe/Moscow',
            },
          },
        },
      }),
    ).rejects.toThrow(/metadata[/\\]x\.xml/)
  })

  it('wraps codegen errors with the connection name (when XML is malformed)', async () => {
    await writeOneFile(join(tmp, 'metadata/x.xml'), '<not valid edmx>')
    await expect(
      runGenerate({
        cwd: tmp,
        cliVersion: '0.0.0-test',
        config: {
          connections: {
            x: {
              baseUrl: 'http://example.test/odata',
              auth: { username: 'u', password: 'p' },
              serverTimezone: 'Europe/Moscow',
            },
          },
        },
      }),
    ).rejects.toThrow(/connection "x"/i)
  })

  it('filters to a single connection when "connection" is set', async () => {
    await writeOneFile(join(tmp, 'metadata/x.xml'), MIN_EDMX)
    await writeOneFile(join(tmp, 'metadata/y.xml'), MIN_EDMX)
    await runGenerate({
      cwd: tmp,
      cliVersion: '0.0.0-test',
      connection: 'x',
      config: {
        connections: {
          x: {
            baseUrl: 'http://example.test/odata',
            auth: { username: 'u', password: 'p' },
            serverTimezone: 'Europe/Moscow',
          },
          y: {
            baseUrl: 'http://example.test/odata',
            auth: { username: 'u', password: 'p' },
            serverTimezone: 'Europe/Moscow',
          },
        },
      },
    })
    expect(existsSync(join(tmp, 'generated/x/index.ts'))).toBe(true)
    expect(existsSync(join(tmp, 'generated/y'))).toBe(false)
  })

  it('embeds inputs triple in __metadata.json when provided', async () => {
    await writeOneFile(join(tmp, 'metadata/x.xml'), MIN_EDMX)
    await runGenerate({
      cwd: tmp,
      cliVersion: '9.9.9-test',
      config: {
        connections: {
          x: {
            baseUrl: 'http://example.test/odata',
            auth: { username: 'u', password: 'p' },
            serverTimezone: 'Europe/Moscow',
          },
        },
      },
    })
    const meta = JSON.parse(readFileSync(join(tmp, 'generated/x/__metadata.json'), 'utf8')) as {
      inputs?: { metadata: string; options: string; cliVersion: string }
    }
    expect(meta.inputs).toBeDefined()
    expect(meta.inputs?.metadata).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(meta.inputs?.options).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(meta.inputs?.cliVersion).toBe('9.9.9-test')
  })

  it('skips regen on second run with identical inputs', async () => {
    await writeOneFile(join(tmp, 'metadata/x.xml'), MIN_EDMX)
    const optsBase = {
      cwd: tmp,
      cliVersion: '0.0.0-test',
      config: {
        connections: {
          x: {
            baseUrl: 'http://example.test/odata',
            auth: { username: 'u', password: 'p' },
            serverTimezone: 'Europe/Moscow',
          },
        },
      },
    } as const
    await runGenerate(optsBase)
    const beforeMtime = statSync(join(tmp, 'generated/x/index.ts')).mtimeMs
    // Wait 5ms to make any rewrite observable via mtime.
    await new Promise((r) => setTimeout(r, 5))
    await runGenerate(optsBase)
    const afterMtime = statSync(join(tmp, 'generated/x/index.ts')).mtimeMs
    expect(afterMtime).toBe(beforeMtime)
  })

  it('regenerates when XML changes between runs', async () => {
    await writeOneFile(join(tmp, 'metadata/x.xml'), MIN_EDMX)
    const optsBase = {
      cwd: tmp,
      cliVersion: '0.0.0-test',
      config: {
        connections: {
          x: {
            baseUrl: 'http://example.test/odata',
            auth: { username: 'u', password: 'p' },
            serverTimezone: 'Europe/Moscow',
          },
        },
      },
    } as const
    await runGenerate(optsBase)
    // Add a new EntityType so XML hash differs.
    const xml2 = MIN_EDMX.replace(
      '</Schema>',
      '<EntityType Name="Catalog_Y"><Key><PropertyRef Name="Ref_Key"/></Key>' +
        '<Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/></EntityType></Schema>',
    )
    await writeOneFile(join(tmp, 'metadata/x.xml'), xml2)
    await runGenerate(optsBase)
    expect(existsSync(join(tmp, 'generated/x/catalogs/Y.ts'))).toBe(true)
  })

  it('regenerates when codegen-relevant options change', async () => {
    await writeOneFile(join(tmp, 'metadata/x.xml'), MIN_EDMX)
    await runGenerate({
      cwd: tmp,
      cliVersion: '0.0.0-test',
      config: {
        connections: {
          x: {
            baseUrl: 'http://example.test/odata',
            auth: { username: 'u', password: 'p' },
            serverTimezone: 'Europe/Moscow',
          },
        },
      },
    })
    const file1 = readFileSync(join(tmp, 'generated/x/__metadata.json'), 'utf8')
    await runGenerate({
      cwd: tmp,
      cliVersion: '0.0.0-test',
      config: {
        connections: {
          x: {
            baseUrl: 'http://example.test/odata',
            auth: { username: 'u', password: 'p' },
            serverTimezone: 'Europe/Moscow',
            shape: { int64Mode: 'bigint' },
          },
        },
      },
    })
    const file2 = readFileSync(join(tmp, 'generated/x/__metadata.json'), 'utf8')
    expect(file1).not.toBe(file2)
  })

  it('regenerates when cliVersion changes', async () => {
    await writeOneFile(join(tmp, 'metadata/x.xml'), MIN_EDMX)
    const config = {
      connections: {
        x: {
          baseUrl: 'http://example.test/odata',
          auth: { username: 'u', password: 'p' },
          serverTimezone: 'Europe/Moscow',
        },
      },
    }
    await runGenerate({ cwd: tmp, cliVersion: '0.1.0-test', config })
    const meta1 = JSON.parse(readFileSync(join(tmp, 'generated/x/__metadata.json'), 'utf8')) as {
      inputs: { cliVersion: string }
    }
    await runGenerate({ cwd: tmp, cliVersion: '0.2.0-test', config })
    const meta2 = JSON.parse(readFileSync(join(tmp, 'generated/x/__metadata.json'), 'utf8')) as {
      inputs: { cliVersion: string }
    }
    expect(meta1.inputs.cliVersion).toBe('0.1.0-test')
    expect(meta2.inputs.cliVersion).toBe('0.2.0-test')
  })

  it('regenerates when prior __metadata.json is malformed', async () => {
    await writeOneFile(join(tmp, 'metadata/x.xml'), MIN_EDMX)
    await writeOneFile(join(tmp, 'generated/x/__metadata.json'), '{not valid json')
    await runGenerate({
      cwd: tmp,
      cliVersion: '0.0.0-test',
      config: {
        connections: {
          x: {
            baseUrl: 'http://example.test/odata',
            auth: { username: 'u', password: 'p' },
            serverTimezone: 'Europe/Moscow',
          },
        },
      },
    })
    expect(existsSync(join(tmp, 'generated/x/index.ts'))).toBe(true)
  })

  it('regenerates when prior __metadata.json lacks inputs field', async () => {
    await writeOneFile(join(tmp, 'metadata/x.xml'), MIN_EDMX)
    // Pre-populate a "previous-format" metadata.json without inputs:
    await writeOneFile(join(tmp, 'generated/x/__metadata.json'), JSON.stringify({ schema: 'StandardODATA' }))
    await runGenerate({
      cwd: tmp,
      cliVersion: '0.0.0-test',
      config: {
        connections: {
          x: {
            baseUrl: 'http://example.test/odata',
            auth: { username: 'u', password: 'p' },
            serverTimezone: 'Europe/Moscow',
          },
        },
      },
    })
    expect(existsSync(join(tmp, 'generated/x/index.ts'))).toBe(true)
    const meta = JSON.parse(readFileSync(join(tmp, 'generated/x/__metadata.json'), 'utf8')) as {
      inputs?: { cliVersion: string }
    }
    expect(meta.inputs).toBeDefined()
  })

  it('--force regenerates even when inputs unchanged', async () => {
    await writeOneFile(join(tmp, 'metadata/x.xml'), MIN_EDMX)
    const optsBase = {
      cwd: tmp,
      cliVersion: '0.0.0-test',
      config: {
        connections: {
          x: {
            baseUrl: 'http://example.test/odata',
            auth: { username: 'u', password: 'p' },
            serverTimezone: 'Europe/Moscow',
          },
        },
      },
    } as const
    await runGenerate(optsBase)
    const before = statSync(join(tmp, 'generated/x/index.ts')).mtimeMs
    await new Promise((r) => setTimeout(r, 5))
    await runGenerate({ ...optsBase, force: true })
    const after = statSync(join(tmp, 'generated/x/index.ts')).mtimeMs
    expect(after).toBeGreaterThan(before)
  })

  it('per-connection: stale X regenerated, fresh Y skipped, in same run', async () => {
    await writeOneFile(join(tmp, 'metadata/x.xml'), MIN_EDMX)
    await writeOneFile(join(tmp, 'metadata/y.xml'), MIN_EDMX)
    const optsBase = {
      cwd: tmp,
      cliVersion: '0.0.0-test',
      config: {
        connections: {
          x: {
            baseUrl: 'http://example.test/odata',
            auth: { username: 'u', password: 'p' },
            serverTimezone: 'Europe/Moscow',
          },
          y: {
            baseUrl: 'http://example.test/odata',
            auth: { username: 'u', password: 'p' },
            serverTimezone: 'Europe/Moscow',
          },
        },
      },
    } as const
    await runGenerate(optsBase)
    // Make X stale — change its XML; Y unchanged.
    await writeOneFile(
      join(tmp, 'metadata/x.xml'),
      MIN_EDMX.replace(
        '</Schema>',
        '<EntityType Name="Catalog_Z"><Key><PropertyRef Name="Ref_Key"/></Key>' +
          '<Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/></EntityType></Schema>',
      ),
    )
    const yIndexBefore = statSync(join(tmp, 'generated/y/index.ts')).mtimeMs
    await new Promise((r) => setTimeout(r, 5))
    await runGenerate(optsBase)
    expect(existsSync(join(tmp, 'generated/x/catalogs/Z.ts'))).toBe(true) // X regenerated
    const yIndexAfter = statSync(join(tmp, 'generated/y/index.ts')).mtimeMs
    expect(yIndexAfter).toBe(yIndexBefore) // Y skipped — mtime unchanged
  })
})
