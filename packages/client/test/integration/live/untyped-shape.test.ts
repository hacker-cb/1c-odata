import { describe, expect, it } from 'vitest'
import { activeFixtures, makeClient } from '../helpers.js'

// Schema-less data-shape contract against live bases (see STABILITY.md
// "Schema-less (untyped) contract"): without a metadataIndex the parser has
// no type information, so Edm.Int64 stays a wire string while Edm.DateTime
// is still recognized by the regex heuristic.
for (const { fixture, profile } of activeFixtures()) {
  describe(`live untyped shape: ${fixture.id}`, () => {
    it('Edm.Int64 stays a wire string without a metadataIndex (LineNumber)', async () => {
      const client = makeClient(fixture)
      // Tabular-part entity set of the smoke document — LineNumber is the
      // standard Edm.Int64 key every 1С tabular part has.
      const { value } = await client.query(`${profile.smoke.countDocument}_Товары`).top(1).get()
      // Tolerate an empty base: no rows → nothing to assert against.
      if (value.length === 0) return
      expect(typeof value[0]?.LineNumber).toBe('string')
    }, 60_000)
  })
}
