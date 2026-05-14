import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFiles, writeOneFile } from '../../src/writer.js'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), '1c-odata-writer-'))
})
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe('writeOneFile', () => {
  it('writes a file, creating parent dirs', async () => {
    await writeOneFile(join(tmp, 'a/b/c.txt'), 'hello')
    expect(readFileSync(join(tmp, 'a/b/c.txt'), 'utf8')).toBe('hello')
  })

  it('overwrites existing file', async () => {
    await writeOneFile(join(tmp, 'x.txt'), 'old')
    await writeOneFile(join(tmp, 'x.txt'), 'new')
    expect(readFileSync(join(tmp, 'x.txt'), 'utf8')).toBe('new')
  })

  it('preserves cyrillic in path and content', async () => {
    await writeOneFile(join(tmp, 'каталоги/Номенклатура.ts'), 'export interface X {}')
    expect(readFileSync(join(tmp, 'каталоги/Номенклатура.ts'), 'utf8')).toBe('export interface X {}')
  })
})

describe('writeFiles (Map -> dir)', () => {
  it('writes every Map entry under root', async () => {
    const files = new Map<string, string>([
      ['catalogs/Валюты.ts', 'a'],
      ['documents/РТУ.ts', 'b'],
      ['index.ts', 'c'],
      ['__metadata.json', '{}'],
    ])
    await writeFiles(tmp, files)
    expect(readFileSync(join(tmp, 'catalogs/Валюты.ts'), 'utf8')).toBe('a')
    expect(readFileSync(join(tmp, 'documents/РТУ.ts'), 'utf8')).toBe('b')
    expect(readFileSync(join(tmp, 'index.ts'), 'utf8')).toBe('c')
    expect(readFileSync(join(tmp, '__metadata.json'), 'utf8')).toBe('{}')
  })
})
