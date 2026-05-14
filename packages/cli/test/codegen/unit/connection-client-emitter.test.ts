import { describe, expect, it } from 'vitest'
import { emitConnectionClientFile } from '../../../src/codegen/emitter/connection-client.js'

describe('emitConnectionClientFile', () => {
  describe('with hasFunctionImports = true', () => {
    it('emits a client.ts file that imports Functions from local function-imports.js', () => {
      const out = emitConnectionClientFile(true)
      expect(out).toContain(`import type { Functions } from './function-imports.js'`)
    })

    it('types createClient<Functions> and Promise<ODataV3Client<Functions>>', () => {
      const out = emitConnectionClientFile(true)
      expect(out).toContain('Promise<ODataV3Client<Functions>>')
    })

    it('snapshot — with FunctionImports', () => {
      expect(emitConnectionClientFile(true)).toMatchSnapshot()
    })
  })

  describe('with hasFunctionImports = false (default)', () => {
    it('does not import Functions — omits function-imports.js dependency', () => {
      const out = emitConnectionClientFile(false)
      expect(out).not.toContain(`import type { Functions } from './function-imports.js'`)
    })

    it('types createClient() and Promise<ODataV3Client> (untyped, uses default)', () => {
      const out = emitConnectionClientFile(false)
      expect(out).toContain('Promise<ODataV3Client>')
      expect(out).not.toContain('Promise<ODataV3Client<')
    })

    it('snapshot — without FunctionImports', () => {
      expect(emitConnectionClientFile(false)).toMatchSnapshot()
    })
  })

  describe('common to both', () => {
    it('imports loadMetadataIndex + ODataV3Client + types from @1c-odata/client', () => {
      const out = emitConnectionClientFile()
      expect(out).toContain('loadMetadataIndex')
      expect(out).toContain('ODataV3Client')
      expect(out).toContain('ODataV3ClientOptions')
      expect(out).toContain(`from '@1c-odata/client'`)
    })

    it('resolves __metadata.json path relative to the file via import.meta.url', () => {
      const out = emitConnectionClientFile()
      expect(out).toContain('import.meta.url')
      expect(out).toContain('__metadata.json')
    })

    it('exports an async createClient(opts) function', () => {
      const out = emitConnectionClientFile()
      expect(out).toMatch(/export async function createClient\s*\(/)
    })

    it('takes Omit<ODataV3ClientOptions, "metadataIndex"> — caller cannot override the auto-load', () => {
      const out = emitConnectionClientFile()
      expect(out).toContain(`Omit<ODataV3ClientOptions, 'metadataIndex'>`)
    })
  })
})
