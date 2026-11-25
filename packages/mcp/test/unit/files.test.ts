import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveDownloadDir, safeFileName } from '../../src/tools/files.js'

describe('resolveDownloadDir', () => {
  it('defaults to <dataDir>/downloads', () => {
    expect(resolveDownloadDir('/data', {})).toBe(join('/data', 'downloads'))
  })

  it('reads an absolute ONEC_MCP_DOWNLOAD_DIR', () => {
    expect(resolveDownloadDir('/data', { ONEC_MCP_DOWNLOAD_DIR: '/tmp/dl' })).toBe('/tmp/dl')
  })

  it('rejects a relative ONEC_MCP_DOWNLOAD_DIR', () => {
    expect(() => resolveDownloadDir('/data', { ONEC_MCP_DOWNLOAD_DIR: 'dl' })).toThrow(/absolute/)
  })
})

describe('safeFileName', () => {
  it('keeps Cyrillic names and replaces path separators and reserved characters', () => {
    expect(safeFileName('УПД №190/26 от 23.11.26.pdf')).toBe('УПД №190_26 от 23.11.26.pdf')
    expect(safeFileName('a\\b:c*d?"e<f>g|h')).toBe('a_b_c_d__e_f_g_h')
  })

  it('cannot climb out of the directory', () => {
    expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd')
    expect(safeFileName('..')).toBe('file')
  })

  it('drops control characters and bounds the length', () => {
    expect(safeFileName('a\u0000b\u001fc')).toBe('abc')
    expect(safeFileName('x'.repeat(300))).toHaveLength(150)
  })

  it('falls back for an empty name', () => {
    expect(safeFileName('   ', 'file')).toBe('file')
  })
})
