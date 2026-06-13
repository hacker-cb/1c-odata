import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ConnectionPool } from './connection-pool.js'
import { registerDataTools } from './tools/data.js'
import { registerSchemaTools } from './tools/schema.js'

export interface CreateServerOptions {
  dataDir: string
  /** Force the plaintext-file secret backend. */
  insecure?: boolean
  /** Reported as the MCP server version. */
  version?: string
}

/**
 * Build the read-only MCP server: one {@link ConnectionPool} shared by all
 * tools, schema-introspection and data tools registered against it.
 */
export function createMcpServer(opts: CreateServerOptions): McpServer {
  const pool = new ConnectionPool({ dataDir: opts.dataDir, insecure: opts.insecure ?? false })
  const server = new McpServer({ name: '1c-odata', version: opts.version ?? '0.0.0' })
  registerSchemaTools(server, pool)
  registerDataTools(server, pool)
  return server
}

/** Create the server and serve it over stdio until the transport closes. */
export async function runServe(opts: CreateServerOptions): Promise<void> {
  const server = createMcpServer(opts)
  await server.connect(new StdioServerTransport())
}
