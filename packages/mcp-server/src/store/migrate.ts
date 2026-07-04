// src/store/migrate.ts
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DbHandle } from './db.js'
import * as schema from './schema.js'

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
    // Dynamic import so the pg (prod) path never loads drizzle-kit. It IS a runtime
    // dependency (the CLI defaults to pglite), kept external from the bundle so it
    // resolves from node_modules — see tsdown.config.ts.
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
  await migrate(handle.db as any, { migrationsFolder: migrationsFolder() })
}
