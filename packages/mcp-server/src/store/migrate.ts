// src/store/migrate.ts
import { fileURLToPath } from 'node:url'
import type { DbHandle } from './db.js'
import * as schema from './schema.js'

/** Committed SQL migrations dir (drizzle-kit generate output), resolved from this module. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url))

/**
 * Create better-auth's tables in the handle's DB.
 *
 * Two mechanisms, one schema (`auth-schema.ts`) feeding both — chosen because
 * better-auth's runtime `getMigrations()`/`runMigrations()` is Kysely-only and
 * CANNOT create tables for a bare PGlite (`kysely-pglite` is not installed). So we
 * drive the Drizzle schema directly:
 *
 *   - pglite (dev/tests): `drizzle-kit/api` `pushSchema` — file-free, fast,
 *     diffs the schema straight into the ephemeral in-memory DB.
 *   - pg (prod): `migrate()` applies the committed ./drizzle SQL for prod parity.
 */
export async function runAuthMigrations(handle: DbHandle): Promise<void> {
  if (handle.dialect === 'pglite') {
    // Dynamic import: drizzle-kit is a devDependency; never pulled into the prod path.
    const { pushSchema } = await import('drizzle-kit/api')
    const { apply } = await pushSchema(
      schema as Record<string, unknown>,
      // biome-ignore lint/suspicious/noExplicitAny: pushSchema wants a PgDatabase<any>; the pglite handle is structurally compatible.
      handle.db as any,
    )
    await apply()
    return
  }
  const { migrate } = await import('drizzle-orm/node-postgres/migrator')
  // biome-ignore lint/suspicious/noExplicitAny: the migrator is over-narrow on the union handle.
  await migrate(handle.db as any, { migrationsFolder: MIGRATIONS_FOLDER })
}
