// packages/mcp/src/internal.ts
/**
 * Internal subpath: cross-package escape hatch for `@1c-odata/mcp-server` and
 * integration tests / tooling.
 *
 * Symbols re-exported here are NOT semver-stable. Minor releases MAY break them.
 * End-user code should never import from `@1c-odata/mcp/internal`. Safe because
 * all `@1c-odata/*` packages are one changesets `fixed` group and release in
 * lock-step, so published versions cannot drift.
 *
 * See `STABILITY.md` for the boundary policy. This is where the reusable building
 * blocks live: the connection pool + its source seam, the read-only tool
 * registrators, and response-limit helpers — everything a multi-tenant host needs
 * to stand up its own scoped server. The connection-management tools
 * (`add`/`remove`/`set_credentials`/`set_label`) are deliberately NOT exported —
 * those are admin operations, not part of the remote read surface.
 */

// The pool's canonical "no such connection" error. Re-exported so a scoped host
// (`@1c-odata/mcp-server`'s ScopedPool) can throw the SAME error the pool throws
// for an absent base — an ungranted base is then byte-identical to a missing one,
// no existence leak, and no direct `@1c-odata/client` dependency on the host.
export { InvalidArgumentError } from '@1c-odata/client'
// On-disk descriptor shape + secret-store escape hatch (for tests/tooling).
export type { StoredConnection } from './config.js'
// Shared data-dir resolver: honors `ONEC_MCP_DATA_DIR` + the absolute-path guard,
// so an alternate host (`@1c-odata/mcp-server`) locates the SAME config.json +
// credentials as the `1c-odata-mcp` CLI instead of diverging on a bare resolve().
// The connection-name validator travels alongside so a DB-backed admin write path
// (`@1c-odata/mcp-server`) enforces the SAME ASCII alias rule as the file store.
export { assertValidConnectionName, isValidConnectionName, resolveDataDir } from './config.js'
// Connection pool + its read-facing contract.
export {
  ConnectionPool,
  type ConnectionPoolOptions,
  type ConnectionSummary,
  type PoolEntry,
  type ReadPool,
} from './connection-pool.js'
// The pluggable origin of connections + secrets (the multi-tenancy seam).
export type { ConnectionSource, ListedConnection } from './connection-source.js'
// Standalone reachability probe (fetch `$metadata` for a credential pair). No
// dataDir dependency — a remote host reuses it to verify a base before saving it
// and in a health job. The connection-MANAGEMENT functions in the same module
// (`upsertConnection`/`removeConnection`/`updateConnectionCredentials`/
// `setConnectionLabel`) stay private: they are bound to the file-backed config.
export { verifyConnectivity } from './connections.js'
export { FileConnectionSource, type FileConnectionSourceOptions } from './file-connection-source.js'
// Response limits.
export { clampTop, DEFAULT_LIMITS, type Limits, resolveLimits } from './limits.js'
export { passwordEnvVar, type SecretSource, SecretStore } from './secret-store.js'
// The uniform tool-result wrapper — so a scoped remote server can register its own
// small read-only tools (e.g. a redacted, DB-aware `server_info`) with the same
// success/error envelope the built-in tools use.
export { toolResult } from './tools/_result.js'
// Read-only tool registrators — reused verbatim by a scoped remote server.
export { registerDataTools } from './tools/data.js'
export { registerSchemaTools } from './tools/schema.js'
export { registerServerInfoTool, type ServerInfoToolOptions } from './tools/server-info.js'
