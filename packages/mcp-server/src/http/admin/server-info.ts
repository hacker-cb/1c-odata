// src/http/admin/server-info.ts
import type { AdminDeps } from './router.js'

/**
 * DB-aware server-info string for the dashboard. Counts bases from the DB (via
 * BaseRepo) rather than loadConfig(dataDir) — the file-based count the shared
 * @1c-odata/mcp server_info tool reports is meaningless on the tenancy path.
 */
export async function adminServerInfo(deps: Pick<AdminDeps, 'baseRepo' | 'version'>): Promise<string> {
  const bases = await deps.baseRepo.list()
  return `1c-odata MCP v${deps.version} — ${bases.length} base(s) configured (DB-backed, multi-tenant).`
}
