import { createServer, type Server } from 'node:http'
import { ConnectionPool, type ConnectionSource, type Limits, type ReadPool } from '@1c-odata/mcp/internal'
import { createApp } from './http/app.js'
import { buildMcpServer } from './server-factory.js'
import { readPackageVersion } from './version.js'

export interface CreateHttpServerOptions {
  /** Origin of connection descriptors + secrets backing the shared pool. */
  source: ConnectionSource
  /** On-disk data directory, reported by `server_info`. */
  dataDir: string
  /** Reported as the MCP server version; defaults to this package's version. */
  version?: string
  /** Response limits; forwarded to every per-session server. */
  limits?: Limits
}

/**
 * Build the HTTP MCP server: one shared {@link ConnectionPool} (its `$metadata`
 * cache reused across sessions) feeding a fresh per-session {@link McpServer}.
 * Returns an unstarted `http.Server` — the caller (`cli.ts` / a host) calls
 * `.listen(...)`. No auth in this slice.
 */
export function createHttpServer(opts: CreateHttpServerOptions): Server {
  const version = opts.version ?? readPackageVersion()
  const pool: ReadPool = new ConnectionPool(opts.source)
  const buildServer = () =>
    buildMcpServer(pool, {
      version,
      dataDir: opts.dataDir,
      ...(opts.limits !== undefined ? { limits: opts.limits } : {}),
    })
  const app = createApp({ buildServer })
  return createServer(app)
}
