#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Command } from 'commander'
import { runAdd } from './commands/add.js'
import { runLabel } from './commands/label.js'
import { runList } from './commands/list.js'
import { runRemove } from './commands/remove.js'
import { runSetCredentials } from './commands/set-credentials.js'
import { runTest } from './commands/test.js'
import { resolveDataDir } from './config.js'
import { errorText } from './redact.js'

interface GlobalOptions {
  dataDir?: string
  insecureStorage?: boolean
}

interface AddCommandOptions {
  url?: string
  login?: string
  password?: string
  passwordStdin?: boolean
  timezone?: string
  label?: string
  force?: boolean
  /** commander sets this to `false` when --no-verify is passed. */
  verify?: boolean
}

interface SetCredentialsCommandOptions {
  login?: string
  password?: string
  passwordStdin?: boolean
  /** commander sets this to `false` when --no-verify is passed. */
  verify?: boolean
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
    // Route the --data-dir flag through resolveDataDir too, so it gets the same
    // trim + absolute-path guard as the ONEC_MCP_DATA_DIR env override.
    return resolveDataDir(process.env, opts.dataDir)
  }
  const insecure = (): boolean => program.opts<GlobalOptions>().insecureStorage === true

  program
    .command('serve')
    .description('Run the read-only MCP server over stdio (how MCP clients launch it)')
    .action(async () => {
      // Lazy import so the management commands don't pay the MCP SDK load cost.
      const { runServe } = await import('./server.js')
      await runServe({ dataDir: dataDir(), insecure: insecure(), version: readPackageVersion() })
    })

  program
    .command('add')
    .description('Add or update a connection (interactive, or non-interactive with --url)')
    .argument('[name]', 'connection name (prompted when omitted; required with --url)')
    .option('--url <url>', 'base URL — enables non-interactive mode')
    .option('--login <login>', 'username (non-interactive)')
    .option('--password <password>', 'password (non-interactive; visible in `ps` — prefer --password-stdin or env)')
    .option('--password-stdin', 'read the password from stdin (non-interactive)')
    .option('--timezone <tz>', 'IANA server timezone (default Europe/Moscow)')
    .option('--label <label>', 'display label shown in lists (defaults to the name)')
    .option('-f, --force', 'overwrite an existing connection without prompting', false)
    .option('--no-verify', 'skip the connectivity check')
    .action(async (name: string | undefined, cmdOpts: AddCommandOptions) => {
      await runAdd({
        dataDir: dataDir(),
        insecure: insecure(),
        ...(name !== undefined ? { name } : {}),
        ...(cmdOpts.url !== undefined ? { url: cmdOpts.url } : {}),
        ...(cmdOpts.login !== undefined ? { login: cmdOpts.login } : {}),
        ...(cmdOpts.password !== undefined ? { password: cmdOpts.password } : {}),
        ...(cmdOpts.passwordStdin === true ? { passwordStdin: true } : {}),
        ...(cmdOpts.timezone !== undefined ? { timezone: cmdOpts.timezone } : {}),
        ...(cmdOpts.label !== undefined ? { label: cmdOpts.label } : {}),
        ...(cmdOpts.force === true ? { force: true } : {}),
        ...(cmdOpts.verify === false ? { noVerify: true } : {}),
      })
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

  program
    .command('label')
    .description("Set or clear a connection's display label")
    .argument('<name>', 'connection name')
    .argument('[label]', 'new label (omit or pass an empty string to clear it)')
    .action(async (name: string, label: string | undefined) => {
      await runLabel({ dataDir: dataDir(), name, label: label ?? '' })
    })

  program
    .command('set-credentials')
    .aliases(['set-creds', 'creds'])
    .description("Change a connection's login and/or password (keeps URL, timezone, label)")
    .argument('<name>', 'connection name')
    .option('--login <login>', 'new username (keeps the current one when omitted)')
    .option('--password <password>', 'new password (visible in `ps` — prefer --password-stdin)')
    .option('--password-stdin', 'read the new password from stdin')
    .option('--no-verify', 'skip the connectivity check')
    .action(async (name: string, cmdOpts: SetCredentialsCommandOptions) => {
      await runSetCredentials({
        dataDir: dataDir(),
        insecure: insecure(),
        name,
        ...(cmdOpts.login !== undefined ? { login: cmdOpts.login } : {}),
        ...(cmdOpts.password !== undefined ? { password: cmdOpts.password } : {}),
        ...(cmdOpts.passwordStdin === true ? { passwordStdin: true } : {}),
        ...(cmdOpts.verify === false ? { noVerify: true } : {}),
      })
    })

  // Note: serve is intentionally NOT the default command. With no subcommand,
  // commander prints help — so a bare `1c-odata-mcp` in a terminal shows the
  // command list instead of silently starting the stdio server and hanging on
  // JSON-RPC. MCP clients launch it with an explicit `serve` (see README). A root
  // .action() is deliberately avoided here: it would suppress commander's
  // generated `help [command]` subcommand.
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
