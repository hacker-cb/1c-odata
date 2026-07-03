import {
  type Limits,
  type ReadPool,
  registerDataTools,
  registerSchemaTools,
  registerServerInfoTool,
  resolveLimits,
} from '@1c-odata/mcp/internal'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export interface BuildMcpServerOptions {
  /** Reported as the MCP server version and by `server_info`. */
  version: string
  /** Passed to `server_info` (the on-disk data directory backing the pool). */
  dataDir: string
  /** Response limits; defaults to {@link resolveLimits} over `process.env`. */
  limits?: Limits
}

/**
 * Build one read-only {@link McpServer} bound to a {@link ReadPool}. Registers the
 * schema + data + server-info tools verbatim from `@1c-odata/mcp/internal`.
 *
 * The management tools (`add` / `remove` / `set_credentials` / `set_label`) are
 * deliberately NOT registered — they are admin operations, not part of the
 * remote read surface (see the `@1c-odata/mcp` internal.ts docstring).
 *
 * One server is built per HTTP session; the `pool` is shared across sessions so
 * the in-memory `$metadata` cache is reused.
 */
export function buildMcpServer(pool: ReadPool, opts: BuildMcpServerOptions): McpServer {
  const limits = opts.limits ?? resolveLimits()
  const server = new McpServer({ name: '1c-odata', version: opts.version })
  registerSchemaTools(server, pool, limits)
  registerDataTools(server, pool, limits)
  registerServerInfoTool(server, { version: opts.version, dataDir: opts.dataDir })
  return server
}
