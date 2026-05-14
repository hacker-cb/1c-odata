import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMetadataIndex, ParseError } from '@1c-odata/client'
import { beforeAll, describe, expect, it } from 'vitest'
import { activeFixtures, makeClient } from '../helpers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Depends on examples/basic having a freshly generated __metadata.json —
// sources the canonical member list from
// MetadataIndex.enums.СпособыУстановкиКурсаВалюты and asserts the live wire
// value falls inside that set.
//
// Fail-loud (not skip) when the fixture is missing: a silent skip masks the
// CI dependency on `pnpm -F basic-example generate`. If you hit this locally,
// run that command first.
const METADATA_PATH = join(__dirname, '../../../../../examples/basic/generated/default/__metadata.json')

const ENUM_NAME = 'СпособыУстановкиКурсаВалюты'
const ENTITY = 'Catalog_Валюты'
const FIELD = 'СпособУстановкиКурса'

for (const { fixture, profile } of activeFixtures()) {
  // BP base also has Catalog_Валюты but the field mapping is trade-specific
  // for this regression test. Keep narrow.
  if (!profile.id.startsWith('trade')) continue

  describe(`live enum roundtrip: ${fixture.id}`, () => {
    let client: ReturnType<typeof makeClient>
    let memberNames: Set<string>

    beforeAll(async () => {
      client = makeClient(fixture)
      // loadMetadataIndex wraps every failure in ParseError — for ENOENT (file
      // truly missing) we want a hint pointing at `pnpm generate`; for everything
      // else (malformed JSON, schema mismatch) we must surface the original
      // ParseError so the real diagnosis isn't masked.
      const idx = await loadMetadataIndex(METADATA_PATH).catch((err: unknown) => {
        const fsCause = err instanceof ParseError ? (err.cause as { code?: string } | undefined) : undefined
        if (fsCause?.code === 'ENOENT') {
          throw new Error(
            `Metadata fixture missing at ${METADATA_PATH}. ` +
              `Run 'pnpm -F basic-example generate' first (offline; uses committed metadata/default.xml).`,
            { cause: err },
          )
        }
        throw err
      })
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
