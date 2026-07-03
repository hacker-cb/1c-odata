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
 */
export * from '../../auth-schema.js'
