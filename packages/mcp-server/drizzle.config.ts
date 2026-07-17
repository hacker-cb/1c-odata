// drizzle.config.ts
import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit config for generating the committed prod SQL. Points at the combined
 * barrel (better-auth's generated `auth-schema.ts` + the hand-written
 * `tenancy-schema.ts`) so `generate` emits DDL for BOTH the auth tables and the
 * tenancy tables (bases / base_secrets / grants / health) into ./drizzle. drizzle-kit
 * resolves the `export *` chain, so pointing at the barrel is enough.
 *
 * `generate` (SQL into ./drizzle) produces the single source of truth: BOTH prod
 * (pg) and dev/tests (pglite) apply that same committed SQL via a drizzle-orm
 * migrator — see src/store/migrate.ts. The url is only needed for `push`/`migrate`
 * against a live DB, not for `generate`.
 */
export default defineConfig({
  schema: './src/store/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
})
