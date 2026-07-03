#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileConnectionSource } from '@1c-odata/mcp/internal'
import { Command } from 'commander'
import { createHttpServer } from './index.js'
import { logger } from './logger.js'
import { readPackageVersion } from './version.js'

const DEFAULT_PORT = 3000
const DEFAULT_HOST = '127.0.0.1'

interface ServeOptions {
  dataDir: string
  insecureStorage?: boolean
  port: string
  host: string
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
    .requiredOption('--data-dir <path>', 'data directory for config + credentials')
    .option('--insecure-storage', 'store passwords in a 0600 file instead of the OS keychain', false)
    .option('--port <port>', 'TCP port to listen on', String(DEFAULT_PORT))
    .option('--host <host>', 'host/interface to bind', DEFAULT_HOST)
    .action((opts: ServeOptions) => {
      const dataDir = resolve(opts.dataDir)
      const insecure = opts.insecureStorage === true
      const port = Number.parseInt(opts.port, 10)
      const source = new FileConnectionSource({ dataDir, insecure })
      const server = createHttpServer({ source, dataDir })
      server.listen(port, opts.host, () => {
        logger.info({ host: opts.host, port, dataDir }, 'MCP HTTP server listening')
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
