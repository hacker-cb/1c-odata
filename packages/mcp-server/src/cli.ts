#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileConnectionSource, resolveDataDir } from '@1c-odata/mcp/internal'
import { Command } from 'commander'
import { createHttpServer } from './index.js'
import { logger } from './logger.js'
import { readPackageVersion } from './version.js'

const DEFAULT_PORT = 3000
const DEFAULT_HOST = '127.0.0.1'

interface ServeOptions {
  dataDir?: string
  insecureStorage?: boolean
  port: string
  host: string
}

/**
 * `Host` allowlist for the transport's DNS-rebinding guard.
 * `ONEC_MCP_ALLOWED_HOSTS` (comma-separated `host:port`) overrides for
 * reverse-proxy deployments where the public `Host` differs from the bound
 * address; otherwise derive it from the bind address plus the loopback aliases a
 * local client may present.
 */
function resolveAllowedHosts(env: NodeJS.ProcessEnv, host: string, port: number): string[] {
  const override = env.ONEC_MCP_ALLOWED_HOSTS?.trim()
  if (override !== undefined && override !== '') {
    return override
      .split(',')
      .map((h) => h.trim())
      .filter((h) => h !== '')
  }
  // A bare IPv6 literal (e.g. `::1`) appears bracketed in the `Host` header
  // (`[::1]:3000`); match that form so the guard doesn't reject legit requests.
  const bind = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return [...new Set([`${bind}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`])]
}

/** Parse + validate `--port`; fail early and clearly instead of letting `listen` throw late on NaN. */
function parsePort(raw: string): number {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port ${JSON.stringify(raw)}: expected an integer in 0..65535`)
  }
  return port
}

/** Build the commander program. Exported for unit tests. */
export function buildProgram(): Command {
  const program = new Command()
  program
    .name('1c-odata-mcp-server')
    .description('Streamable HTTP MCP server for 1С:Enterprise OData V3 (read-only)')
    .version(readPackageVersion())

  program
    .command('serve')
    .description('Run the read-only MCP server over Streamable HTTP')
    // Optional + routed through resolveDataDir so the server locates the SAME
    // config.json + credentials as the `1c-odata-mcp` CLI: honors
    // ONEC_MCP_DATA_DIR and the absolute-path guard, defaulting to the per-OS dir.
    .option('--data-dir <path>', 'data directory for config + credentials (default: per-OS config dir)')
    .option('--insecure-storage', 'store passwords in a 0600 file instead of the OS keychain', false)
    .option('--port <port>', 'TCP port to listen on', String(DEFAULT_PORT))
    .option('--host <host>', 'host/interface to bind', DEFAULT_HOST)
    .action((opts: ServeOptions) => {
      const dataDir = resolveDataDir(process.env, opts.dataDir)
      const insecure = opts.insecureStorage === true
      const port = parsePort(opts.port)
      const allowedHosts = resolveAllowedHosts(process.env, opts.host, port)
      const source = new FileConnectionSource({ dataDir, insecure })
      const server = createHttpServer({ source, dataDir, allowedHosts })
      server.listen(port, opts.host, () => {
        logger.info({ host: opts.host, port, dataDir, allowedHosts }, 'MCP HTTP server listening')
      })
    })

  return program
}

// Run when invoked as the bin. Canonicalize argv[1] through realpath — pnpm
// exposes the package as a symlink, so argv[1] and import.meta.url otherwise
// disagree even for the same file.
function realArgvUrl(): string | undefined {
  const raw = process.argv[1]
  if (raw === undefined) return undefined
  try {
    return pathToFileURL(realpathSync(raw)).href
  } catch {
    try {
      return pathToFileURL(resolve(raw)).href
    } catch {
      return undefined
    }
  }
}

if (realArgvUrl() === import.meta.url) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'fatal')
      process.exitCode = 1
    })
}
