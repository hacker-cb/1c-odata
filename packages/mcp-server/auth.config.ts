// auth.config.ts
/**
 * Build-only config module for `@better-auth/cli generate`. The CLI needs a
 * module exporting `auth` to introspect the plugin set and emit the Drizzle
 * schema (auth-schema.ts).
 *
 * It calls the SAME `buildAuth` factory the runtime uses (src/auth/better-auth.ts),
 * so the plugin set (jwt + admin + oauthProvider) CANNOT drift from the runtime —
 * there is nothing to keep in sync by hand. Not imported by any runtime code: this
 * is the build side of CLAUDE.md's build-vs-runtime split.
 *
 * The urls/db/secret are throwaway. Schema generation reads the plugin and option
 * shapes, never the database — the drizzle adapter is constructed but never
 * queried during `generate` — so a localhost url, an in-memory PGlite, and a dummy
 * secret are enough to reproduce the exact tables the runtime expects.
 */
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { buildAuth } from './src/auth/better-auth.js'
import { resolveCanonicalUrls } from './src/auth/config.js'
import type { AuthDb } from './src/store/db.js'

export const auth = buildAuth({
  urls: resolveCanonicalUrls('http://localhost:3000'),
  // `generate` never runs a query, so cast a schema-less PGlite handle to AuthDb
  // rather than importing the (generated) schema barrel just to satisfy the type.
  db: drizzle(new PGlite()) as unknown as AuthDb,
  secret: 'schema-generation-only-not-a-real-secret-0123456789',
})
