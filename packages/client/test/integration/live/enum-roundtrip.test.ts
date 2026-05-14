import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMetadataIndex } from '@1c-odata/client'
import { beforeAll, describe, expect, it } from 'vitest'
import { activeFixtures, makeClient } from '../helpers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Depends on examples/basic having a freshly generated __metadata.json —
// sources the canonical member list from
// MetadataIndex.enums.СпособыУстановкиКурсаВалюты and asserts the live wire
// value falls inside that set.
const METADATA_PATH = join(__dirname, '../../../../../examples/basic/generated/default/__metadata.json')

const ENUM_NAME = 'СпособыУстановкиКурсаВалюты'
const ENTITY = 'Catalog_Валюты'
const FIELD = 'СпособУстановкиКурса'

for (const { fixture, profile } of activeFixtures()) {
  // BP base also has Catalog_Валюты but the field mapping is trade-specific
  // for this regression test. Keep narrow.
  if (!profile.id.startsWith('trade')) continue

  describe.skipIf(!existsSync(METADATA_PATH))(`live enum roundtrip: ${fixture.id}`, () => {
    let client: ReturnType<typeof makeClient>
    let memberNames: Set<string>

    beforeAll(async () => {
      client = makeClient(fixture)
      const idx = await loadMetadataIndex(METADATA_PATH)
      const enumDecl = idx.enums?.[ENUM_NAME]
      if (!enumDecl) {
        throw new Error(
          `Metadata at ${METADATA_PATH} is missing enum "${ENUM_NAME}". ` +
            `Regenerate examples/basic via 'pnpm -F basic-example generate'.`,
        )
      }
      memberNames = new Set(enumDecl.members.map((m) => m.name))
      expect(memberNames.size).toBeGreaterThan(0)
    })

    it(`every ${ENTITY}.${FIELD} value is a member of ${ENUM_NAME}`, async () => {
      const result = await client
        .query<{ Description: string; [k: string]: unknown }>(ENTITY)
        .top(20)
        .select('Description', FIELD)
        .get({ timeout: 30_000 })

      expect(result.value.length).toBeGreaterThan(0)
      const seenValues = new Set<string>()
      for (const row of result.value) {
        const v = row[FIELD]
        // 1С may return null/undefined or an empty string for currencies without
        // a configured update method. The empty string is the 1С wire
        // representation of the default (zero-index) enum value — treated the
        // same as null here: not a named member, so skip rather than fail.
        if (v === null || v === undefined || v === '') continue
        expect(typeof v).toBe('string')
        const sv = v as string
        seenValues.add(sv)
        if (!memberNames.has(sv)) {
          throw new Error(
            `${ENTITY}.${FIELD} wire value "${sv}" is NOT in emitted ${ENUM_NAME} members: ` +
              `${[...memberNames].join(', ')}`,
          )
        }
      }
      // Defensive: at least one non-null sample must be seen, otherwise the
      // assertion above is vacuously satisfied.
      expect(seenValues.size).toBeGreaterThan(0)
    }, 30_000)
  })
}
