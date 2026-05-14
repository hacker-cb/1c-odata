#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Command } from 'commander'
import { runFetch } from './commands/fetch.js'
import { runGenerate } from './commands/generate.js'
import { loadConfig } from './config.js'

interface CommandOptions {
  connection?: string
  config?: string
  force?: boolean
}

/**
 * Read this package's version from its `package.json`. Resolved relative to
 * the compiled `dist/cli.js` (one level up) or the source `src/cli.ts`
 * (two levels up). Falls back to `0.0.0` if either lookup fails — the
 * version string is informational and we never want a missing file to
 * crash the bin.
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
  const cliVersion = readPackageVersion()
  const program = new Command()
  program
    .name('1c-odata')
    .description('CLI for @1c-odata: fetch metadata + generate TypeScript types')
    .version(cliVersion)

  program
    .command('fetch')
    .description('Download $metadata for one or all connections')
    .option('-c, --connection <name>', 'connection name (defaults to all)')
    .option('--config <path>', 'override config file path')
    .action(async (opts: CommandOptions) => {
      const cwd = process.cwd()
      const loaded = await loadConfig({
        cwd,
        ...(opts.config !== undefined ? { configFile: opts.config } : {}),
      })
      await runFetch({
        cwd: loaded.cwd,
        config: loaded.config,
        ...(opts.connection !== undefined ? { connection: opts.connection } : {}),
      })
    })

  program
    .command('generate')
    .description('Generate TypeScript types from local metadata')
    .option('-c, --connection <name>', 'connection name (defaults to all)')
    .option('--config <path>', 'override config file path')
    .option('-f, --force', 'regenerate even when inputs are unchanged', false)
    .action(async (opts: CommandOptions) => {
      const cwd = process.cwd()
      const loaded = await loadConfig({
        cwd,
        ...(opts.config !== undefined ? { configFile: opts.config } : {}),
      })
      await runGenerate({
        cwd: loaded.cwd,
        config: loaded.config,
        cliVersion,
        ...(opts.connection !== undefined ? { connection: opts.connection } : {}),
        ...(opts.force === true ? { force: true } : {}),
      })
    })

  return program
}

// Run if invoked as bin. Resolve `argv[1]` through `realpath` first — pnpm
// workspaces expose this package under `node_modules/@1c-odata/cli` as a
// symlink to `packages/cli`, and without canonicalization `argv[1]` and
// `import.meta.url` point at different paths even though they refer to the
// same file. `realpathSync` may throw (deleted file, permission); fall back
// to the raw path so the comparison still works in non-symlink setups.
function realArgvUrl(): string | undefined {
  const raw = process.argv[1]
  if (raw === undefined) return undefined
  try {
    return pathToFileURL(realpathSync(raw)).href
  } catch {
    return pathToFileURL(raw).href
  }
}
const isBinEntry = realArgvUrl() === import.meta.url
if (isBinEntry) {
  const program = buildProgram()
  program.parseAsync(process.argv).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    if (process.env.DEBUG !== undefined && err instanceof Error && err.stack !== undefined) {
      process.stderr.write(`${err.stack}\n`)
    } else {
      process.stderr.write(`Error: ${message}\n`)
    }
    process.exitCode = 1
  })
}
