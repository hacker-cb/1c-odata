// test/unit/auth-schema-parity.test.ts
/**
 * Parity between the RUNTIME better-auth table model and the committed Drizzle
 * schema — the auth-side counterpart of the cli package's `metadata-parity` test.
 *
 * Why this exists, given CI gate 2c already re-derives auth-schema.ts:
 *
 * Gate 2c re-runs `@better-auth/cli generate` and diffs the result. But the CLI
 * bundles its OWN nested `better-auth` (currently the 1.4.x line) while the server
 * runs 1.6.x — the two packages are versioned independently, with no peer-dependency
 * or documented compatibility contract between them. So gate 2c compares the
 * generator's output against the generator's output: if the CLI's model ever drifts
 * from the runtime's, BOTH sides of that comparison move together and the gate stays
 * green while the shipped schema no longer matches what the server queries.
 *
 * This test closes that hole by deriving the expectation from a genuinely independent
 * source: `getAuthTables()` reads the in-process model of the SAME `better-auth` the
 * server imports at runtime. A CLI/runtime skew that gate 2c cannot see fails here.
 *
 * It reflects the BARREL (src/store/schema.ts), not auth-schema.ts, because the
 * barrel is what the runtime actually resolves models against: src/store/db.ts passes
 * `{ schema }` (the barrel) to drizzle, and `drizzleAdapter` falls back to
 * `db._.fullSchema`. So this checks the merged object graph the adapter really sees,
 * not just the generated file.
 *
 * NOT covered here — one collision class this test structurally cannot see. If the
 * hand-written tenancy module ever exported a name that auth-schema.ts also exports,
 * real Node ESM drops that name from the barrel namespace entirely (ambiguous star
 * export), and the adapter would fail to resolve the model at runtime. Vite does NOT
 * reproduce that: it resolves the collision first-wins and keeps the auth table, so
 * the defect is invisible under vitest (verified by deliberately colliding on
 * `session` — `undefined` under `node`, the correct table under vitest). The backstop
 * for that case is the e2e suite, which boots the real server on real Node.
 *
 * Assertions are one-directional: every better-auth model/field must be present.
 * The barrel legitimately carries EXTRA tables (bases, base_secrets, grants, health,
 * setup_token), so set-equality would be wrong.
 */
import { getAuthTables } from 'better-auth/db'
import { is } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { buildAuth } from '../../src/auth/better-auth.js'
import { resolveCanonicalUrls } from '../../src/auth/config.js'
import type { AuthDb } from '../../src/store/db.js'
import * as barrel from '../../src/store/schema.js'

/**
 * The runtime option set. Only the plugin set matters for the table model, and that
 * comes from `buildAuth` — the very factory the server uses — so the url/db/secret
 * are throwaway (nothing here opens a connection or signs anything).
 *
 * `db` is a stub rather than a real PGlite handle on purpose: `drizzleAdapter` only
 * stores it, and reading the schema never issues a query. Spinning up PGlite here
 * would allocate a WASM instance the suite would then have to tear down, for no gain.
 *
 * The stub still carries `_.fullSchema`, because that is the one property the adapter
 * genuinely reads (`config.schema || db._.fullSchema` — see src/store/db.ts). Pointing
 * it at the same barrel the runtime passes keeps the stub faithful instead of merely
 * empty, so an adapter that starts resolving models eagerly fails this test for real
 * parity reasons rather than for missing plumbing.
 */
function runtimeAuthTables() {
  const auth = buildAuth({
    urls: resolveCanonicalUrls('http://localhost:3000'),
    db: { _: { fullSchema: barrel } } as unknown as AuthDb,
    secret: 'schema-parity-test-only-not-a-real-secret-0123456789',
  })
  return getAuthTables((auth as unknown as { options: Parameters<typeof getAuthTables>[0] }).options)
}

/** Drizzle tables exported by the barrel, keyed by export name. */
function barrelTables(): Record<string, PgTable> {
  return Object.fromEntries(Object.entries(barrel).filter(([, v]) => is(v, PgTable))) as Record<string, PgTable>
}

/**
 * Column metadata keyed by the drizzle PROPERTY name — which is what the adapter
 * looks up, not the snake_cased database column name.
 */
function columnsByProperty(table: PgTable) {
  const out = new Map<string, { name: string; notNull: boolean; isUnique: boolean }>()
  for (const [prop, col] of Object.entries(table as unknown as Record<string, unknown>)) {
    if (col && typeof col === 'object' && 'name' in col && 'notNull' in col) {
      const c = col as { name: string; notNull: boolean; isUnique?: boolean }
      out.set(prop, { name: c.name, notNull: c.notNull, isUnique: c.isUnique ?? false })
    }
  }
  return out
}

const authTables = runtimeAuthTables()
const tables = barrelTables()
const modelNames = Object.keys(authTables)

describe('auth schema parity: runtime better-auth model vs committed drizzle schema', () => {
  // The per-model checks below are ONE-DIRECTIONAL: they assert every field the
  // runtime declares exists in the schema. That is deliberate (the barrel carries
  // extra tenancy tables, and an extra column is harmless), but it means a SHRINKING
  // runtime model — a plugin silently dropped from buildAuth — would let them all
  // pass vacuously. These two tests pin the plugin surface so that cannot happen.
  it('exposes the expected plugin table set (jwt, oauthProvider)', () => {
    expect(modelNames).toEqual(
      expect.arrayContaining([
        'user',
        'session',
        'account',
        'verification',
        'jwks', // jwt()
        'oauthClient', // oauthProvider()
        'oauthAccessToken',
        'oauthRefreshToken',
        'oauthConsent',
      ]),
    )
  })

  it('exposes the admin() plugin columns on user', () => {
    // admin() contributes no table of its own — only columns — so the table-set
    // check above cannot see it disappear. Without this, dropping admin() from
    // buildAuth shrinks the user model and every remaining assertion still passes,
    // while the running server loses role/ban enforcement.
    // `?? {}` keeps this type-safe without weakening it: if the user model ever went
    // missing entirely, the empty key list fails `arrayContaining` just as loudly.
    expect(Object.keys(authTables.user?.fields ?? {})).toEqual(
      expect.arrayContaining(['role', 'banned', 'banReason', 'banExpires']),
    )
  })

  it.each(modelNames)('model %s is present in the barrel schema', (model) => {
    expect(
      tables[model],
      `better-auth model "${model}" has no table exported from src/store/schema.ts. ` +
        'Regenerate with `pnpm -F @1c-odata/mcp-server auth:schema` — or, if it is present ' +
        'in auth-schema.ts but missing here, an ambiguous star export in the barrel is ' +
        'shadowing it.',
    ).toBeDefined()
  })

  it.each(modelNames)('model %s has every field the runtime declares', (model) => {
    const table = tables[model]
    const spec = authTables[model]
    if (!table || !spec) return // reported by the previous test; don't cascade a confusing failure
    const cols = columnsByProperty(table)

    // better-auth treats `id` as implicit — it is never in `fields`.
    expect(cols.has('id'), `table for "${model}" has no id column`).toBe(true)

    for (const [key, field] of Object.entries(spec.fields)) {
      const prop = field.fieldName ?? key
      const col = cols.get(prop)
      expect(
        col,
        `better-auth model "${model}" declares field "${prop}" but the committed schema has no ` +
          `such column (has: ${[...cols.keys()].join(', ')})`,
      ).toBeDefined()
      if (!col) continue

      // `required` is what the adapter relies on when writing rows: a column the
      // runtime considers mandatory but the schema leaves nullable accepts NULLs
      // the runtime never expects to read back.
      expect(col.notNull, `${model}.${prop}: notNull should be ${field.required === true}`).toBe(
        field.required === true,
      )

      // Both directions. A MISSING unique lets duplicates through; an EXTRA one is
      // just as harmful the other way — better-auth would legitimately write a second
      // row (a per-user token or consent record) and the database would reject it.
      expect(col.isUnique, `${model}.${prop}: unique should be ${field.unique === true}`).toBe(field.unique === true)
    }
  })

  it.each(modelNames)('model %s has the foreign keys the runtime declares', (model) => {
    const table = tables[model]
    const spec = authTables[model]
    if (!table || !spec) return
    const fks = getTableConfig(table).foreignKeys.map((fk) => {
      const ref = fk.reference()
      return {
        from: ref.columns.map((c) => c.name).join(','),
        toTable: getTableConfig(ref.foreignTable).name,
        toColumn: ref.foreignColumns.map((c) => c.name).join(','),
        onDelete: (fk as unknown as { onDelete?: string }).onDelete,
      }
    })
    const cols = columnsByProperty(table)

    for (const [key, field] of Object.entries(spec.fields)) {
      if (!field.references) continue
      const prop = field.fieldName ?? key
      const from = cols.get(prop)?.name
      const targetTable = tables[field.references.model]
      if (!from || !targetTable) continue // covered by the checks above
      const toTable = getTableConfig(targetTable).name
      // The TARGET COLUMN matters and is not always `id`: the oauth tables reference
      // `oauthClient.clientId`, so matching only (source column, target table) would
      // accept an FK pointing at `oauthClient.id` — a different column entirely.
      const toColumn = columnsByProperty(targetTable).get(field.references.field)?.name
      const expected: Record<string, unknown> = { from, toTable, toColumn }
      // Only assert the delete action where the runtime actually declares one. For
      // the rest the runtime says nothing and the generator picks `cascade` on its
      // own, so there is no expectation to compare against.
      if (field.references.onDelete) expected.onDelete = field.references.onDelete
      expect(
        fks,
        `${model}.${prop} should reference ${field.references.model}.${field.references.field}`,
      ).toContainEqual(expect.objectContaining(expected))
    }
  })
})
