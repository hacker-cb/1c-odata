// src/store/tenancy-schema.ts
/**
 * HAND-WRITTEN tenancy tables — never touched by @better-auth/cli (it only
 * regenerates ../../auth-schema.ts). Imports `user` from that generated file
 * purely to anchor the grants.sub FK; the dependency is one-way (tenancy → auth),
 * so regenerating auth-schema.ts never rewrites this file.
 *
 * drizzle-kit emits all CREATE TABLEs before all FK ALTER TABLEs, and the
 * _journal sequences user (0000) before these tables (0001), so grants.sub →
 * user.id never fires against a missing table — no manual ordering needed.
 */
import { customType, index, jsonb, pgTable, primaryKey, smallint, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from '../../auth-schema.js'

/**
 * Postgres `bytea` ⇄ Node Buffer both ways (drizzle-orm 0.45 has no first-class
 * bytea). Used for the GCM nonce/ciphertext/tag — raw bytes, never base64 in DB.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

/** JSON form of client's DataShape — structural, so the class isn't imported into the column type. */
export interface DataShapeJson {
  int64Mode?: 'number' | 'bigint' | 'string'
  dateMode?: 'date' | 'string'
}

/** Non-secret 1С connection descriptors — the DB analogue of config.json entries. */
export const bases = pgTable('bases', {
  /** Connection alias / PK. ASCII (isValidConnectionName enforced on the admin write path). */
  name: text('name').primaryKey(),
  baseUrl: text('base_url').notNull(),
  login: text('login').notNull(),
  serverTimezone: text('server_timezone').notNull(),
  /** Optional display label (may be Cyrillic). Absent → name shown. */
  label: text('label'),
  /** Optional DataShape override as JSON. */
  shape: jsonb('shape').$type<DataShapeJson>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
})

/**
 * Encrypted 1С passwords, one row per base. PK = base_name (FK → bases, cascade).
 * The four crypto columns are the {@link SealedSecret} envelope; AAD = base_name.
 */
export const baseSecrets = pgTable('base_secrets', {
  baseName: text('base_name')
    .primaryKey()
    .references(() => bases.name, { onDelete: 'cascade' }),
  keyId: smallint('key_id').notNull(),
  nonce: bytea('nonce').notNull(),
  ciphertext: bytea('ciphertext').notNull(),
  tag: bytea('tag').notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
})

/**
 * Per-user access grants. PK (sub, base_name): at most one grant per (user, base).
 * `sub` = better-auth user.id (the JWT `sub`, a text PK) → text FK. `scope` is
 * the write-axis seed — stored + returned, but Slice 3 gates only on MEMBERSHIP,
 * never on the value (read tools only). Revocation = delete row; effective next call.
 */
export const grants = pgTable(
  'grants',
  {
    sub: text('sub')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    baseName: text('base_name')
      .notNull()
      .references(() => bases.name, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['read', 'write'] })
      .notNull()
      .default('read'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sub, t.baseName] }),
    index('grants_sub_idx').on(t.sub),
    index('grants_base_name_idx').on(t.baseName),
  ],
)

/**
 * First-run setup token — the one-time bootstrap secret gating the `/setup`
 * wizard. A single logical row: the boot hook generates one while no admin
 * exists, and the wizard deletes it once the first admin is created (single-use).
 *
 * The token value is stored in the clear ON PURPOSE. It is an ephemeral bootstrap
 * secret with a hard lifecycle bound: it only unlocks `/setup`, and `/setup`
 * itself is 404 the instant ANY admin exists — so a leaked token is worthless
 * once onboarding is done. It is also never presented to an untrusted party (it
 * is printed only to the server log). And DB-read access already implies host
 * compromise, at which point the attacker can seed an admin row directly and the
 * token is moot — hashing it here would add no defense against that threat.
 */
export const setupToken = pgTable('setup_token', {
  // Fixed key (always the string 'singleton'): a restart or concurrent boot that
  // inserts a fresh token conflicts on `id` and KEEPS the first token, so the
  // logged /setup URL stays stable and the table never grows past one row. (Making
  // `token` itself the PK would let each boot's new random token insert a new row.)
  id: text('id').primaryKey(),
  token: text('token').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

/** Last connectivity/health probe per base. Redacted status/error — never a secret. */
export const health = pgTable('health', {
  baseName: text('base_name')
    .primaryKey()
    .references(() => bases.name, { onDelete: 'cascade' }),
  status: text('status', { enum: ['ok', 'auth_failed', 'unreachable'] }).notNull(),
  lastCheck: timestamp('last_check').defaultNow().notNull(),
  error: text('error'),
})
