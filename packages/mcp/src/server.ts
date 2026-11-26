import type { Readable, Writable } from 'node:stream'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ConnectionPool } from './connection-pool.js'
import { FileConnectionSource } from './file-connection-source.js'
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
 * write only the MCP's own connection config (add/remove). Closing the server
 * closes its pool: the `$metadata` downloads in flight are aborted, which no
 * single call's cancel does, a download being shared by every call waiting on
 * its connection (#233).
 */
export function createMcpServer(opts: CreateServerOptions): McpServer {
  const insecure = opts.insecure ?? false
  const limits = opts.limits ?? resolveLimits()
  const version = opts.version ?? '0.0.0'
  const pool = new ConnectionPool(new FileConnectionSource({ dataDir: opts.dataDir, insecure }))
  const server = new McpServer({ name: '1c-odata', version })
  registerSchemaTools(server, pool, limits)
  registerDataTools(server, pool, limits)
  registerManagementTools(server, pool, { dataDir: opts.dataDir, insecure })
  registerServerInfoTool(server, { version, dataDir: opts.dataDir })
  server.server.onclose = () => pool.close()
  return server
}

/**
 * Create the server and serve it over stdio until the client closes its end of
 * stdin; resolves once the server has closed.
 */
export async function runServe(opts: CreateServerOptions): Promise<void> {
  await serveStdio(opts, process.stdin, process.stdout)
}

/**
 * {@link runServe} over the given streams. The end of `stdin` (EOF, or the
 * stream closing) closes the server — the MCP stdio transport's shutdown
 * signal — and so does an error on either stream (the client gone mid-write):
 * the SDK aborts the signal of every tool call still running, which aborts its
 * requests to 1С, and the pool its `$metadata` downloads — so nothing keeps
 * loading 1С, or the process alive, for a client that has gone (#233).
 *
 * @internal Exported for tests.
 */
export async function serveStdio(opts: CreateServerOptions, stdin: Readable, stdout: Writable): Promise<void> {
  const server = createMcpServer(opts)
  const transport = new StdioServerTransport(stdin, stdout)
  // The SDK chains a transport's own onclose, set before connect, ahead of its own.
  const closed = new Promise<void>((resolve) => {
    transport.onclose = resolve
  })
  const close = (): void => {
    void server.close()
  }
  stdin.once('end', close)
  stdin.once('close', close)
  // Kept past the close: a stream error with no listener left would crash the process.
  stdin.on('error', close)
  stdout.on('error', close)
  try {
    await server.connect(transport)
    // A stdin already at its end before the listeners went on emits neither event again.
    if (stdin.readableEnded || stdin.destroyed) close()
    await closed
  } finally {
    stdin.off('end', close)
    stdin.off('close', close)
  }
}
