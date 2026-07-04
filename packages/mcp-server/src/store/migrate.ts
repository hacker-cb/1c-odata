// src/store/migrate.ts
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DbHandle } from './db.js'

/**
 * The committed SQL migrations dir (`<packageRoot>/drizzle`, the drizzle-kit
 * output), located by walking up from THIS module to the nearest ancestor that
 * has a `package.json`, then `/drizzle`.
 *
 * A fixed relative path can't work here: from source this module is
 * `src/store/migrate.ts` (two levels under the package root), but tsdown bundles
 * it to `dist/*.js` (ONE level under the root), so `../../drizzle` would resolve
 * a directory too high in the built package. Walking to the package.json is
 * robust across both layouts (and the installed node_modules layout). The
 * `drizzle/` folder ships via the package `files` allowlist so it exists at runtime.
 */
export function migrationsFolder(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return join(dir, 'drizzle')
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Fallback to the source-relative layout if no package.json was found.
  return fileURLToPath(new URL('../../drizzle', import.meta.url))
}

/**
 * Create better-auth's tables in the handle's DB by applying the committed
 * ./drizzle SQL — the SINGLE source of truth for BOTH dev/tests and prod.
 *
 * We drive the Drizzle schema directly (not better-auth's own runtime migrator,
 * which is Kysely-only and CANNOT create tables for a bare PGlite —
 * `kysely-pglite` is not installed). Both dialects run the same committed SQL via
 * a drizzle-orm migrator, so CI exercises the EXACT DDL prod runs (test-what-you-
 * ship) and the committed SQL cannot silently drift from the schema the tests
 * expect. Each dialect has its own migrator, differing only in the bound driver:
 *
 *   - pglite (dev/tests): `drizzle-orm/pglite/migrator`.
 *   - pg (prod): `drizzle-orm/node-postgres/migrator`.
 *
 * `drizzle-kit generate` (regenerating this SQL from the schema) is a build-time
 * concern; nothing here loads drizzle-kit at runtime. The CI `gate 2c` fails the
 * build if the committed SQL drifts from the TS schema.
 */
export async function runAuthMigrations(handle: DbHandle): Promise<void> {
  const config = { migrationsFolder: migrationsFolder() }
  // Dynamic imports keep each dialect's migrator (and its driver) off the other
  // path — the pg prod bundle never pulls the pglite migrator and vice versa.
  if (handle.dialect === 'pglite') {
    const { migrate } = await import('drizzle-orm/pglite/migrator')
    // biome-ignore lint/suspicious/noExplicitAny: the migrator is over-narrow on the union handle.
    await migrate(handle.db as any, config)
    return
  }
  const { migrate } = await import('drizzle-orm/node-postgres/migrator')
  // biome-ignore lint/suspicious/noExplicitAny: the migrator is over-narrow on the union handle.
  await migrate(handle.db as any, config)
}
