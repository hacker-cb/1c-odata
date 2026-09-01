// src/tenancy/grants.ts
/**
 * Fresh, uncached grant resolution. The ScopedPool calls this on EVERY get/list
 * so a revoked row stops the NEXT tool-call (not just the next session). A user
 * with no rows resolves to an empty map (sees no bases), never an error.
 *
 * Table + repo live in ../store; this module is just the thin resolver the pool
 * closes over, keeping the tenancy/ layer free of drizzle table imports.
 */
import type { AuthDb } from '../store/db.js'
import { GrantRepo, type GrantScope } from '../store/repos.js'

/** A resolved grant set: base name → its scope. Absence of a key = not granted. */
export type GrantMap = Map<string, GrantScope>

/** Read this user's live grants FRESH — no caching. Empty map when the user has none. */
export async function resolveGrants(db: AuthDb, sub: string): Promise<GrantMap> {
  return new GrantRepo(db).resolve(sub)
}
