// drizzle.config.ts
import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit config for generating the committed prod SQL from the better-auth
 * Drizzle schema. `generate` (SQL into ./drizzle) is what prod applies via
 * migrate(); pglite tests bypass SQL entirely (pushSchema in src/store/migrate.ts).
 * The url is only needed for `push`/`migrate` against a live DB, not for `generate`.
 */
export default defineConfig({
  schema: './auth-schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
})
