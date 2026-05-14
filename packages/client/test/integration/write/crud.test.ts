import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { activeFixtures, makeClient, testPrefix, writesAllowed } from '../helpers.js'

for (const { fixture, profile } of activeFixtures()) {
  describe.skipIf(!writesAllowed() || !profile.crud)(`live write CRUD: ${fixture.id}`, () => {
    // biome-ignore lint/style/noNonNullAssertion: gated by describe.skipIf above
    const crud = profile.crud!
    let client: ReturnType<typeof makeClient>
    const created: string[] = []

    beforeAll(() => {
      client = makeClient(fixture)
    })

    afterAll(async () => {
      // Defensive cleanup — drop anything we created if the test exited mid-flow.
      for (const ref of created) {
        try {
          await client.entity(crud.catalogName, ref).delete({ timeout: 30_000 })
        } catch {
          // best effort
        }
      }
    })

    it(`POST -> PATCH -> markForDeletion -> DELETE on ${crud.catalogName}`, async () => {
      const prefix = testPrefix()

      // 1. CREATE
      const created1 = await client
        .entity<{ Ref_Key: string; Description: string; DataVersion: string }>(crud.catalogName)
        .create({ [crud.descField]: `${prefix}initial` }, { timeout: 30_000 })
      expect(created1.Ref_Key).toMatch(/^[0-9a-f]{8}-/i)
      const refKey = created1.Ref_Key
      created.push(refKey)
      const initialDataVersion = created1.DataVersion

      // 2. PATCH (rename)
      const patched = await client
        .entity<{ Ref_Key: string; Description: string; DataVersion: string }>(crud.catalogName, refKey)
        .patch({ [crud.descField]: `${prefix}renamed` }, { timeout: 30_000 })
      expect(patched.Description).toBe(`${prefix}renamed`)
      expect(patched.DataVersion).not.toBe(initialDataVersion)

      // 3. PATCH (mark for deletion via sugar)
      const marked = await client
        .entity<{ Ref_Key: string; DeletionMark: boolean }>(crud.catalogName, refKey)
        .markForDeletion({ timeout: 30_000 })
      expect(marked.DeletionMark).toBe(true)

      // 4. DELETE (physical)
      await client.entity(crud.catalogName, refKey).delete({ timeout: 30_000 })

      // Mark as cleaned-up so afterAll skips
      created.pop()
    }, 90_000)
  })
}
