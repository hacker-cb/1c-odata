import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ConnectionPool } from './connection-pool.js'
import { type Limits, resolveLimits } from './limits.js'
import { registerDataTools } from './tools/data.js'
import { registerManagementTools } from './tools/management.js'
import { registerSchemaTools } from './tools/schema.js'
import { registerServerInfoTool } from './tools/server-info.js'

export interface CreateServerOptions {
  dataDir: string
  /** Force the plaintext-file secret backend. */
  insecure?: boolean
  /** Reported as the MCP server version. */
  version?: string
  /** Response limits; defaults to {@link resolveLimits} over `process.env`. */
  limits?: Limits
}

/**
 * Build the MCP server: one {@link ConnectionPool} shared by all tools.
 * Data access to 1С is read-only (schema + queries); the management tools
 * write only the MCP's own connection config (add/remove).
 */
export function createMcpServer(opts: CreateServerOptions): McpServer {
  const insecure = opts.insecure ?? false
  const limits = opts.limits ?? resolveLimits()
  const version = opts.version ?? '0.0.0'
  const pool = new ConnectionPool({ dataDir: opts.dataDir, insecure })
  const server = new McpServer({ name: '1c-odata', version })
  registerSchemaTools(server, pool, limits)
  registerDataTools(server, pool, limits)
  registerManagementTools(server, pool, { dataDir: opts.dataDir, insecure })
  registerServerInfoTool(server, { version, dataDir: opts.dataDir })
  return server
}

/** Create the server and serve it over stdio until the transport closes. */
export async function runServe(opts: CreateServerOptions): Promise<void> {
  const server = createMcpServer(opts)
  await server.connect(new StdioServerTransport())
}
