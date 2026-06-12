import { type Connection, parseConnectionUrl } from '@1c-odata/client'
import { describe, expect, it } from 'vitest'
import { createDynamicClient, fetchMetadataIndex } from '../../../src/index.js'

// Live fixtures — same registry contract as packages/client integration tests
// (snapshots/README.md): `ONEC_<ID>_URL` env vars from the repo-root
// .env.local. Without them this file produces zero suites and vitest's
// passWithNoTests lets the run skip cleanly.
const FIXTURE_IDS = ['trade_v11.5', 'bp_v3.0'] as const

function activeConnections(): Array<{ id: string; conn: Connection }> {
  const out: Array<{ id: string; conn: Connection }> = []
  for (const id of FIXTURE_IDS) {
    const fullUrl = process.env[`ONEC_${id.replace(/\./g, '_').toUpperCase()}_URL`]
    if (!fullUrl) continue
    try {
      out.push({ id, conn: { ...parseConnectionUrl(fullUrl), serverTimezone: 'Europe/Moscow' } })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[fetch-metadata.live] skipping fixture ${id}: ${msg}`)
    }
  }
  return out
}

for (const { id, conn } of activeConnections()) {
  describe(`live: runtime metadata against ${id}`, () => {
    it('fetchMetadataIndex builds a full index from live $metadata', async () => {
      const idx = await fetchMetadataIndex(conn)
      expect(idx.schemaNamespace).toBe('StandardODATA')
      expect(Object.keys(idx.schemas).length).toBeGreaterThan(1000)
      expect(idx.entitySetToType['Catalog_Валюты']).toBe('Catalog_Валюты')
      // ValueStorage detection over the wire — same contract the codegen path pins.
      expect(idx.schemas['Catalog_Файлы']?.valueStorages).toContain('ФайлХранилище')
      // Shape defaults are always resolved and persisted.
      expect(idx.shape).toEqual({ int64Mode: 'number', dateMode: 'date' })
    }, 180_000)

    it('createDynamicClient queries a base with zero generated files', async () => {
      const client = await createDynamicClient(conn, { client: { timeout: 30_000 } })
      const { value } = await client.query('Catalog_Валюты').top(2).get()
      expect(Array.isArray(value)).toBe(true)
      expect(value.length).toBeGreaterThan(0)
      expect(typeof value[0]?.Ref_Key).toBe('string')
    }, 180_000)
  })
}
