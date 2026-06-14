import { beforeAll, describe, expect, it } from 'vitest'
import { activeFixtures, makeClient } from '../helpers.js'

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

for (const { fixture, profile } of activeFixtures()) {
  describe(`live getByKeys: ${fixture.id}`, () => {
    let client: ReturnType<typeof makeClient>

    beforeAll(() => {
      client = makeClient(fixture)
    })

    it(`round-trips Ref_Keys through getByKeys on ${profile.smoke.catalogName}`, async () => {
      const set = profile.smoke.catalogName
      // Seed: pull a handful of real Ref_Keys.
      const seed = await client.query<{ Ref_Key: string }>(set).select('Ref_Key').top(15).get({ timeout: 30_000 })
      const keys = seed.value.map((r) => r.Ref_Key)
      expect(keys.length).toBeGreaterThan(0)
      for (const k of keys) expect(k).toMatch(GUID_RE)

      // Force several batches (batchSize=5) → exercises chunking + concurrency live.
      const rows = await client
        .query<{ Ref_Key: string; Description: string }>(set)
        .select('Ref_Key', 'Description')
        .getByKeys('Ref_Key', keys, { batchSize: 5, timeout: 30_000 })

      // Every requested key comes back exactly once (all seed keys exist).
      expect(new Set(rows.map((r) => r.Ref_Key))).toEqual(new Set(keys))
      expect(rows).toHaveLength(keys.length)
    }, 60_000)

    it('dedups duplicate keys and returns [] for an empty list', async () => {
      const set = profile.smoke.catalogName
      const one = await client.query<{ Ref_Key: string }>(set).select('Ref_Key').top(1).get({ timeout: 30_000 })
      const first = one.value[0]
      expect(first?.Ref_Key).toMatch(GUID_RE)
      if (!first) return // narrow for TS; the assertion above already failed the test if empty
      const key = first.Ref_Key

      const dup = await client
        .query<{ Ref_Key: string }>(set)
        .getByKeys('Ref_Key', [key, key, key], { timeout: 30_000 })
      expect(dup).toHaveLength(1)

      const none = await client.query<{ Ref_Key: string }>(set).getByKeys('Ref_Key', [], { timeout: 30_000 })
      expect(none).toEqual([])
    }, 60_000)
  })
}
