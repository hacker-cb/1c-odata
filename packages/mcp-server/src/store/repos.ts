// src/store/repos.ts
/**
 * Thin typed repos over drizzle core queries — one per tenancy table. They hide
 * column↔struct mapping (Buffers ↔ SealedSecret, JSON ↔ DataShape) so
 * DbConnectionSource, ScopedPool, and the admin/health code stay declarative.
 * drizzle's fluent API is parameterized (no SQL-injection surface).
 */
import type { ListedConnection, StoredConnection } from '@1c-odata/mcp/internal'
import { and, eq, like } from 'drizzle-orm'
import { user } from '../../auth-schema.js'
import type { SealedSecret } from './crypto.js'
import type { AuthDb } from './db.js'
import { baseSecrets, bases, type DataShapeJson, grants, health, setupToken } from './tenancy-schema.js'

// The client's `DataShape`, derived from StoredConnection.shape rather than
// imported from `@1c-odata/client` — mcp-server does not depend on client directly
// (all cross-package types flow through @1c-odata/mcp/internal).
type DataShape = NonNullable<StoredConnection['shape']>

/** Grant scope. Slice 3 stores + returns but never inspects the value. */
export type GrantScope = 'read' | 'write'

/** Read/write non-secret base descriptors. */
export class BaseRepo {
  constructor(private readonly db: AuthDb) {}

  async get(name: string): Promise<StoredConnection | undefined> {
    const [row] = await this.db.select().from(bases).where(eq(bases.name, name)).limit(1)
    return row ? toStored(row) : undefined
  }

  async list(): Promise<ListedConnection[]> {
    const rows = await this.db.select().from(bases)
    return rows.map((r) => ({ name: r.name, ...toStored(r) }))
  }

  async upsert(name: string, conn: StoredConnection): Promise<void> {
    const values = toRow(name, conn)
    await this.db.insert(bases).values(values).onConflictDoUpdate({ target: bases.name, set: values })
  }

  /**
   * Insert-only create: returns false (and writes nothing) when `name` already
   * exists. The atomic ON CONFLICT DO NOTHING is what makes the admin panel's
   * no-silent-overwrite invariant hold under real concurrency — a check-then-upsert
   * lets two concurrent creates of the same name both pass the check, with the
   * loser silently replacing the winner's descriptor.
   */
  async create(name: string, conn: StoredConnection): Promise<boolean> {
    // `.returning()` with no column selector — the union AuthDb narrows the
    // arg-taking overload away (same constraint as SetupTokenRepo.consume); only
    // the inserted-row count is load-bearing anyway.
    const inserted = await this.db.insert(bases).values(toRow(name, conn)).onConflictDoNothing().returning()
    return inserted.length > 0
  }

  async delete(name: string): Promise<void> {
    await this.db.delete(bases).where(eq(bases.name, name)) // cascades to secret/grants/health
  }
}

function toRow(name: string, conn: StoredConnection): typeof bases.$inferInsert {
  return {
    name,
    baseUrl: conn.baseUrl,
    login: conn.login,
    serverTimezone: conn.serverTimezone,
    label: conn.label ?? null,
    shape: (conn.shape ?? null) as DataShapeJson | null,
  }
}

function toStored(r: typeof bases.$inferSelect): StoredConnection {
  const shape = normalizeShape(r.shape)
  const label = r.label?.trim()
  return {
    baseUrl: r.baseUrl,
    login: r.login,
    serverTimezone: r.serverTimezone,
    ...(label ? { label } : {}),
    ...(shape ? { shape } : {}),
  }
}

function normalizeShape(raw: DataShapeJson | null): DataShape | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: DataShape = {}
  if (raw.int64Mode === 'number' || raw.int64Mode === 'bigint' || raw.int64Mode === 'string') {
    out.int64Mode = raw.int64Mode
  }
  if (raw.dateMode === 'date' || raw.dateMode === 'string') out.dateMode = raw.dateMode
  return Object.keys(out).length > 0 ? out : undefined
}

/** Read/write the sealed-secret envelope. Pure storage — crypto lives in DbConnectionSource. */
export class SecretRepo {
  constructor(private readonly db: AuthDb) {}

  async get(baseName: string): Promise<SealedSecret | null> {
    const [row] = await this.db.select().from(baseSecrets).where(eq(baseSecrets.baseName, baseName)).limit(1)
    if (!row) return null
    return { keyId: row.keyId, nonce: row.nonce, ciphertext: row.ciphertext, tag: row.tag }
  }

  async has(baseName: string): Promise<boolean> {
    const [row] = await this.db
      .select({ baseName: baseSecrets.baseName })
      .from(baseSecrets)
      .where(eq(baseSecrets.baseName, baseName))
      .limit(1)
    return row !== undefined
  }

  async put(baseName: string, sealed: SealedSecret): Promise<void> {
    const values = {
      baseName,
      keyId: sealed.keyId,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      tag: sealed.tag,
    }
    await this.db.insert(baseSecrets).values(values).onConflictDoUpdate({ target: baseSecrets.baseName, set: values })
  }

  async delete(baseName: string): Promise<void> {
    await this.db.delete(baseSecrets).where(eq(baseSecrets.baseName, baseName))
  }
}

/** Grant CRUD + the ScopedPool's per-call resolver. */
export class GrantRepo {
  constructor(private readonly db: AuthDb) {}

  /** `sub` → Map<baseName, scope>. FRESH each call so revocation is immediate. */
  async resolve(sub: string): Promise<Map<string, GrantScope>> {
    const rows = await this.db
      .select({ baseName: grants.baseName, scope: grants.scope })
      .from(grants)
      .where(eq(grants.sub, sub))
    return new Map(rows.map((r) => [r.baseName, r.scope]))
  }

  async grant(sub: string, baseName: string, scope: GrantScope): Promise<void> {
    await this.db
      .insert(grants)
      .values({ sub, baseName, scope })
      .onConflictDoUpdate({ target: [grants.sub, grants.baseName], set: { scope } })
  }

  async revoke(sub: string, baseName: string): Promise<void> {
    await this.db.delete(grants).where(and(eq(grants.sub, sub), eq(grants.baseName, baseName)))
  }

  /**
   * Drop every grant of one user — the cleanup companion of user deletion. The
   * grants table has no FK into better-auth's `user` table (the plugin owns that
   * schema), so removeUser would otherwise leave orphaned grant rows behind.
   */
  async revokeAll(sub: string): Promise<void> {
    await this.db.delete(grants).where(eq(grants.sub, sub))
  }

  /** All (sub, scope) pairs granted on one base. For the admin grant matrix. */
  async listByBase(baseName: string): Promise<{ sub: string; scope: GrantScope }[]> {
    return this.db.select({ sub: grants.sub, scope: grants.scope }).from(grants).where(eq(grants.baseName, baseName))
  }

  /**
   * Every grant row (sub × base × scope) in ONE query — feeds the admin grant
   * matrix without an N+1 `resolve()` per user (up to 200 sequential queries).
   */
  async listAll(): Promise<{ sub: string; baseName: string; scope: GrantScope }[]> {
    return this.db.select({ sub: grants.sub, baseName: grants.baseName, scope: grants.scope }).from(grants)
  }
}

/** Health-probe results (health job writes, dashboard/tool reads). */
export class HealthRepo {
  constructor(private readonly db: AuthDb) {}

  async upsert(baseName: string, status: 'ok' | 'auth_failed' | 'unreachable', error?: string): Promise<void> {
    const values = { baseName, status, lastCheck: new Date(), error: error ?? null }
    await this.db.insert(health).values(values).onConflictDoUpdate({ target: health.baseName, set: values })
  }

  async list(): Promise<(typeof health.$inferSelect)[]> {
    return this.db.select().from(health)
  }
}

/** The fixed primary key of the single setup-token row (enforces one row). */
const SETUP_TOKEN_ID = 'singleton'

/**
 * The one-time first-run setup token backing the `/setup` wizard. Exactly one row
 * (keyed by {@link SETUP_TOKEN_ID}): `ensure` mints it once and keeps it across
 * restarts, `get` reads it, `clear` deletes it when the first admin is created
 * (single-use). See {@link setupToken} for why the value is stored in the clear.
 */
export class SetupTokenRepo {
  constructor(private readonly db: AuthDb) {}

  /** The current token value, or null when none is stored. */
  async get(): Promise<string | null> {
    const [row] = await this.db
      .select({ token: setupToken.token })
      .from(setupToken)
      .where(eq(setupToken.id, SETUP_TOKEN_ID))
      .limit(1)
    return row?.token ?? null
  }

  /**
   * Ensure the token exists, returning the effective value. The fixed `id` makes
   * this idempotent AND race-safe: a restart or concurrent boot inserting a fresh
   * token conflicts on the singleton key and KEEPS the first token (so the logged
   * URL is stable), rather than accumulating a second row.
   */
  async ensure(token: string): Promise<string> {
    await this.db.insert(setupToken).values({ id: SETUP_TOKEN_ID, token }).onConflictDoNothing()
    // Re-read: on a conflict the existing row's token (not `token`) is authoritative.
    return (await this.get()) ?? token
  }

  /** Delete the token (single-use — called once the first admin is created). */
  async clear(): Promise<void> {
    await this.db.delete(setupToken).where(eq(setupToken.id, SETUP_TOKEN_ID))
  }

  /**
   * Atomically consume the token: delete the singleton row IFF it still holds
   * `token`, returning true only for the caller that won the delete. This makes
   * first-admin creation single-use even under REAL concurrency: pglite serializes
   * queries, but a prod `pg.Pool` runs concurrent POSTs on separate connections, so
   * a read-compare-then-clear (non-atomic) could let two token holders each seed an
   * admin. With an atomic delete-returning, only one concurrent POST proceeds.
   */
  async consume(token: string): Promise<boolean> {
    // `.returning()` with no column selector — the union AuthDb narrows the
    // arg-taking overload away; we only need the deleted-row count anyway.
    const deleted = await this.db
      .delete(setupToken)
      .where(and(eq(setupToken.id, SETUP_TOKEN_ID), eq(setupToken.token, token)))
      .returning()
    return deleted.length > 0
  }
}

/**
 * Number of admin-role users in the better-auth `user` table. Matches
 * {@link adminGate}'s role parsing EXACTLY: better-auth may store roles as a
 * comma/space-separated list (e.g. "admin,user"), and the admin gate authorizes any
 * such value that contains "admin" — so the first-run gate must count them as
 * admins too, else `/setup` would reopen despite an existing (multi-role) admin.
 * The SQL `LIKE '%admin%'` prefilter narrows the scan; JS then confirms exact
 * membership (so "superadmin" is excluded). Drives the gate: zero admins ⇒ `/setup` open.
 */
export async function countAdmins(db: AuthDb): Promise<number> {
  const rows = await db.select({ role: user.role }).from(user).where(like(user.role, '%admin%'))
  return rows.filter((r) => (r.role ?? '').split(/[,\s]+/).some((x) => x === 'admin')).length
}

/**
 * Minimal read of one better-auth user row, for the admin panel's mutation
 * guards (last-admin / self checks) — the admin() plugin exposes no get-by-id
 * endpoint and a listUsers round-trip would be both heavier and racier.
 */
export async function getUserById(
  db: AuthDb,
  id: string,
): Promise<{ id: string; email: string; role: string | null } | undefined> {
  const [row] = await db.select({ id: user.id, email: user.email, role: user.role }).from(user).where(eq(user.id, id))
  return row
}

/** Same role parsing as adminGate/countAdmins: a comma/space-separated list containing "admin". */
export function hasAdminRole(role: string | null | undefined): boolean {
  return (role ?? '').split(/[,\s]+/).some((r) => r === 'admin')
}
