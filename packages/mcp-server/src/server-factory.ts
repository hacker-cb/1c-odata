import {
  type Limits,
  type ReadPool,
  registerDataTools,
  registerSchemaTools,
  registerServerInfoTool,
  resolveLimits,
  toolResult,
} from '@1c-odata/mcp/internal'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export interface BuildMcpServerOptions {
  /** Reported as the MCP server version and by `server_info`. */
  version: string
  /** Passed to `server_info` (the on-disk data directory backing the pool). */
  dataDir: string
  /** Response limits; defaults to {@link resolveLimits} over `process.env`. */
  limits?: Limits
  /**
   * `server_info` variant. `'file'` (default) reports the operator's on-disk
   * `dataDir` + file-config connection count — safe only when the caller owns the
   * host (no-auth / auth-without-tenancy file path). `'tenancy'` reports a
   * REDACTED `server_info` (version + the CALLER's visible connection count via
   * `pool.list()`, NO filesystem path) so a multi-tenant /mcp caller — even a
   * zero-grant token — can never learn the host's `dataDir`.
   */
  serverInfo?: 'file' | 'tenancy'
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
  if (opts.serverInfo === 'tenancy') {
    registerTenancyServerInfoTool(server, pool, opts.version)
  } else {
    registerServerInfoTool(server, { version: opts.version, dataDir: opts.dataDir })
  }
  return server
}

/**
 * Redacted `server_info` for the multi-tenant path. Reports version + the number
 * of bases THIS session can see (through the ScopedPool, so a zero-grant token
 * sees 0), and deliberately NO host filesystem path — the operator's absolute
 * `dataDir` must never leak to a tenant. Mirrors the file variant's read-only,
 * secret-free contract.
 */
function registerTenancyServerInfoTool(server: McpServer, pool: ReadPool, version: string): void {
  server.registerTool(
    'server_info',
    {
      title: 'Server info',
      description:
        'Report this 1С OData MCP server: its version (from the package, same as the MCP handshake) and how many connections are visible to you. Read-only; never returns passwords or host paths.',
      inputSchema: {},
    },
    async () =>
      toolResult(async () => {
        const connections = (await pool.list()).length
        return {
          summary: `1c-odata MCP v${version} — ${connections} connection(s) available.`,
          data: { name: '1c-odata', version, connections },
        }
      }),
  )
}
