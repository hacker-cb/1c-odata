#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Command } from 'commander'
import { runAdd } from './commands/add.js'
import { runList } from './commands/list.js'
import { runRemove } from './commands/remove.js'
import { runTest } from './commands/test.js'
import { resolveDataDir } from './config.js'
import { errorText } from './redact.js'

interface GlobalOptions {
  dataDir?: string
  insecureStorage?: boolean
}

/**
 * Read this package's version from its `package.json`, resolved relative to the
 * compiled `dist/cli.js` (one level up) or the source `src/cli.ts` (two levels
 * up). Falls back to `0.0.0` — a missing file must never crash the bin.
 */
function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [join(here, '..', 'package.json'), join(here, '..', '..', 'package.json')]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string }
      if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version
    } catch {
      // try next candidate
    }
  }
  return '0.0.0'
}

/** Build the commander program. Exported for unit tests. */
export function buildProgram(): Command {
  const program = new Command()
  program
    .name('1c-odata-mcp')
    .description('MCP server + connection manager for 1С:Enterprise OData V3 (read-only)')
    .version(readPackageVersion())
    .option('--data-dir <path>', 'data directory for config + credentials (default: per-OS config dir)')
    .option('--insecure-storage', 'store passwords in a 0600 file instead of the OS keychain', false)

  const dataDir = (): string => {
    const opts = program.opts<GlobalOptions>()
    return opts.dataDir ?? resolveDataDir()
  }
  const insecure = (): boolean => program.opts<GlobalOptions>().insecureStorage === true

  program
    .command('serve', { isDefault: true })
    .description('Run the read-only MCP server over stdio (default command)')
    .action(async () => {
      // Lazy import so the management commands don't pay the MCP SDK load cost.
      const { runServe } = await import('./server.js')
      await runServe({ dataDir: dataDir(), insecure: insecure(), version: readPackageVersion() })
    })

  program
    .command('add')
    .description('Add or update a connection (interactive; password entered with no echo)')
    .argument('[name]', 'connection name (prompted when omitted)')
    .action(async (name?: string) => {
      await runAdd({ dataDir: dataDir(), insecure: insecure(), ...(name !== undefined ? { name } : {}) })
    })

  program
    .command('list')
    .alias('ls')
    .description('List configured connections (never prints passwords)')
    .action(async () => {
      await runList({ dataDir: dataDir(), insecure: insecure() })
    })

  program
    .command('remove')
    .aliases(['rm', 'delete'])
    .description('Remove a connection and its stored password')
    .argument('<name>', 'connection name')
    .option('-y, --yes', 'skip the confirmation prompt', false)
    .action(async (name: string, opts: { yes?: boolean }) => {
      await runRemove({ dataDir: dataDir(), insecure: insecure(), name, yes: opts.yes === true })
    })

  program
    .command('test')
    .description('Verify a stored connection by fetching its $metadata')
    .argument('<name>', 'connection name')
    .action(async (name: string) => {
      await runTest({ dataDir: dataDir(), insecure: insecure(), name })
    })

  return program
}

// Run when invoked as the bin. Canonicalize argv[1] through realpath first —
// pnpm exposes the package as a symlink, so without it argv[1] and
// import.meta.url disagree even for the same file.
function realArgvUrl(): string | undefined {
  const raw = process.argv[1]
  if (raw === undefined) return undefined
  try {
    return pathToFileURL(realpathSync(raw)).href
  } catch {
    // realpath failed — resolve to an absolute path (pathToFileURL requires one).
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
      if (process.env.DEBUG !== undefined && err instanceof Error && err.stack !== undefined) {
        process.stderr.write(`${err.stack}\n`)
      } else {
        process.stderr.write(`Error: ${errorText(err)}\n`)
      }
      process.exitCode = 1
    })
}
