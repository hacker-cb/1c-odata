import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFileAtomic } from '../../src/atomic-write.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-atomic-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('writeFileAtomic', () => {
  it('writes the content at 0600 and leaves no temp sibling', () => {
    const p = join(dir, 'f.json')
    writeFileAtomic(p, '{"a":1}\n')
    expect(readFileSync(p, 'utf8')).toBe('{"a":1}\n')
    if (process.platform !== 'win32') expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('replaces a pre-existing world-readable target with a fresh 0600 inode', () => {
    // The 0600 mode must land even when the target already exists too-open: the
    // wx-created temp inode carries 0600 and the rename installs it over the target.
    const p = join(dir, 'credentials.json')
    writeFileSync(p, 'old', { mode: 0o644 })
    chmodSync(p, 0o644)
    writeFileAtomic(p, 'new')
    expect(readFileSync(p, 'utf8')).toBe('new')
    if (process.platform !== 'win32') expect(statSync(p).mode & 0o777).toBe(0o600)
  })

  it('overwrites repeatedly without accumulating temp files', () => {
    const p = join(dir, 'f.json')
    writeFileAtomic(p, 'a')
    writeFileAtomic(p, 'b')
    writeFileAtomic(p, 'c')
    expect(readFileSync(p, 'utf8')).toBe('c')
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})
