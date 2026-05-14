import { beforeAll, describe, expect, it } from 'vitest'
import { activeFixtures, makeClient } from '../helpers.js'

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

for (const { fixture, profile } of activeFixtures()) {
  describe(`live smoke: ${fixture.id}`, () => {
    let client: ReturnType<typeof makeClient>

    beforeAll(() => {
      client = makeClient(fixture)
    })

    it(`top(1) on ${profile.smoke.catalogName} returns a row with GUID Ref_Key`, async () => {
      const result = await client
        .query<{ Ref_Key: string; Code: string }>(profile.smoke.catalogName)
        .top(1)
        .get({ timeout: 30_000 })

      expect(result.value).toHaveLength(1)
      const row = result.value[0]
      expect(row).toBeDefined()
      // biome-ignore lint/style/noNonNullAssertion: existence asserted on previous line
      expect(row!.Ref_Key).toMatch(GUID_RE)
      // biome-ignore lint/style/noNonNullAssertion: same
      expect(typeof row!.Code).toBe('string')
    }, 30_000)

    it(`count() on ${profile.smoke.countDocument} returns a non-negative integer`, async () => {
      const n = await client.query(profile.smoke.countDocument).count({ timeout: 30_000 })
      expect(Number.isInteger(n)).toBe(true)
      expect(n).toBeGreaterThanOrEqual(0)
    }, 30_000)

    it(`returns null or Date for ${profile.smoke.countDocument}.ДоверенностьДата (parser invariant)`, async () => {
      const result = await client
        .query<{ ДоверенностьДата: Date | null }>(profile.smoke.countDocument)
        .select('ДоверенностьДата')
        .top(3)
        .get({ timeout: 30_000 })

      // Parser invariant: ДоверенностьДата is either null (1С empty-date sentinel
      // 0001-01-01 mapped correctly) or a real Date instance. A regression that
      // emitted the literal sentinel string would fail this for-each.
      for (const row of result.value) {
        const v = row.ДоверенностьДата
        expect(v === null || v instanceof Date).toBe(true)
      }
    }, 30_000)
  })
}
