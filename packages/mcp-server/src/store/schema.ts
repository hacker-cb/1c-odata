// src/store/schema.ts
/**
 * Import seam for better-auth's Drizzle schema. The table definitions themselves
 * are GENERATED (never hand-written) by `@better-auth/cli generate` into the
 * package-root `auth-schema.ts` — regenerate whenever the betterAuth config's
 * plugin set changes (jwt/admin/oauthProvider). Slice 3's tenancy tables get
 * their OWN module and are merged into the adapter separately; this file stays
 * better-auth-only.
 *
 * Re-exporting keeps every `src/` importer decoupled from the generated file's
 * on-disk location (package root, outside src/, so drizzle-kit can scan it).
 *
 * The hand-written tenancy tables (bases / base_secrets / grants / health) are
 * merged in here too, so `db._.fullSchema`, `pushSchema` (pglite tests), and
 * `drizzle-kit generate` all see ONE combined schema — one migration set, one
 * Postgres. `grants.sub` FKs `user.id`, and drizzle-kit sequences the auth tables
 * (0000) before the tenancy tables (0001), so the FK never fires against a missing
 * `user`.
 */
export * from '../../auth-schema.js'
export * from './tenancy-schema.js'
