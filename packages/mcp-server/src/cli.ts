#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileConnectionSource, resolveDataDir } from '@1c-odata/mcp/internal'
import { Command } from 'commander'
import { buildAuth } from './auth/better-auth.js'
import { resolveCanonicalUrls } from './auth/config.js'
import { createHttpServer } from './index.js'
import { logger } from './logger.js'
import { type Keyring, loadKeyring } from './store/crypto.js'
import { createDb, type Dialect } from './store/db.js'
import { runAuthMigrations } from './store/migrate.js'
import { countAdmins } from './store/repos.js'
import { readPackageVersion } from './version.js'

const DEFAULT_PORT = 3000
const DEFAULT_HOST = '127.0.0.1'

interface ServeOptions {
  dataDir?: string
  insecureStorage?: boolean
  port: string
  host: string
  publicUrl?: string
  pgUrl?: string
  authDataDir?: string
  encKey?: string
}

interface AdminCreateOptions {
  email: string
  password: string
  name?: string
  publicUrl?: string
  pgUrl?: string
  authDataDir?: string
  force?: boolean
}

interface SetPasswordOptions {
  email: string
  password: string
  publicUrl?: string
  pgUrl?: string
  authDataDir?: string
}

/**
 * Minimal structural view of better-auth's `$context` — the internal handle the
 * break-glass `set-password` drives. `setUserPassword`/`listUsers` (admin plugin)
 * require an admin SESSION and 401 on the header-less CLI path, so we instead go
 * through the same internal adapter + password hasher those endpoints use.
 */
interface AuthContext {
  password: { hash(plain: string): Promise<string> }
  internalAdapter: {
    findUserByEmail(email: string): Promise<{ user: { id: string } } | null>
    findAccounts(userId: string): Promise<{ providerId: string }[]>
    updatePassword(userId: string, hashed: string): Promise<unknown>
    createAccount(input: { userId: string; providerId: string; accountId: string; password: string }): Promise<unknown>
  }
}

/**
 * Build the encryption keyring iff a KEK is supplied (flag or env) — this is what
 * opts multi-tenancy in on the auth path. Absent → undefined (auth without
 * tenancy, the Slice-2 file source). `loadKeyring` throws {@link MissingEncryptionKeyError}
 * loudly on a malformed/short key, failing boot rather than corrupting writes.
 */
function resolveKeyring(env: NodeJS.ProcessEnv, opts: ServeOptions): Keyring | undefined {
  const encKey = opts.encKey ?? env.ONEC_MCP_ENC_KEY
  if (encKey === undefined || encKey === '') return undefined
  return loadKeyring({ ONEC_MCP_ENC_KEY: encKey, ONEC_MCP_ENC_KEY_ID: env.ONEC_MCP_ENC_KEY_ID } as NodeJS.ProcessEnv)
}

/**
 * The `Host`-header value(s) a client presents for the public origin. The
 * transport matches the raw `Host` header by EXACT string, and clients drop a
 * default port (`https://x` → `Host: x`, `https://x:8443` → `Host: x:8443`), so
 * `URL.host` is the canonical form — plus, when the port is defaulted, the
 * explicit `host:defaultPort` form in case a proxy keeps it. Returns `[]` for an
 * unparseable URL (the origin is validated for real by `resolveCanonicalUrls`).
 */
export function publicUrlHostVariants(publicUrl: string): string[] {
  let url: URL
  try {
    url = new URL(publicUrl)
  } catch {
    return []
  }
  const variants = [url.host]
  if (url.port === '') {
    const def = url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : ''
    if (def !== '') variants.push(`${url.hostname}:${def}`)
  }
  return variants
}

/**
 * `Host` allowlist for the transport's DNS-rebinding guard. The transport matches
 * the raw `Host` header by exact string, so entries are raw `Host` values —
 * `host` (default port omitted, as clients send it) or `host:port`.
 * `ONEC_MCP_ALLOWED_HOSTS` (comma-separated) is an explicit override, respected
 * verbatim. Otherwise derive it from the bind address plus the loopback
 * aliases a local client may present, AND — when `--public-url` is set — the
 * public origin's `Host` form, so a reverse-proxy deployment that forwards the
 * original `Host` needs no separate `ONEC_MCP_ALLOWED_HOSTS`.
 */
export function resolveAllowedHosts(env: NodeJS.ProcessEnv, host: string, port: number, publicUrl?: string): string[] {
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
  // Include both loopback families: a client may reach the server via either the
  // IPv4 or the IPv6 loopback regardless of the bind address (e.g. `--host ::`
  // still answers `http://[::1]:<port>`), and each yields a distinct `Host` header.
  const hosts = [`${bind}:${port}`, `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]
  // Behind a proxy the public `Host` (from --public-url) differs from the bind
  // address; auto-allow it so the common single-instance proxy case needs no
  // ONEC_MCP_ALLOWED_HOSTS. An explicit override above still wins.
  if (publicUrl !== undefined && publicUrl !== '') hosts.push(...publicUrlHostVariants(publicUrl))
  return [...new Set(hosts)]
}

/**
 * Parse + validate `--port`; fail early and clearly instead of letting `listen`
 * throw late on NaN. Port 0 (OS-assigned ephemeral) is rejected: the bound port
 * would differ from the one baked into the DNS-rebinding allowlist, so the guard
 * would reject every request.
 */
function parsePort(raw: string): number {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port ${JSON.stringify(raw)}: expected an integer in 1..65535`)
  }
  return port
}

/**
 * Resolve the auth store dialect. Prod: --pg-url / DATABASE_URL → node-postgres.
 * Dev: --auth-data-dir / ONEC_MCP_AUTH_DATA_DIR → persistent pglite; absent →
 * in-memory pglite (state resets each run — dev/demo only).
 */
function resolveDialect(env: NodeJS.ProcessEnv, opts: ServeOptions): Dialect {
  const pg = opts.pgUrl ?? env.DATABASE_URL
  if (pg !== undefined && pg !== '') return { kind: 'pg', connectionString: pg }
  const dir = opts.authDataDir ?? env.ONEC_MCP_AUTH_DATA_DIR
  return dir !== undefined && dir !== '' ? { kind: 'pglite', dataDir: dir } : { kind: 'pglite' }
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
    // Auth (Slice 2). Absent --public-url → no-auth server (Slice-1 behavior).
    .option('--public-url <url>', 'external https origin enabling OAuth auth (e.g. https://mcp.example.com)')
    .option('--pg-url <url>', 'Postgres connection string for the auth store (else DATABASE_URL; else pglite)')
    .option('--auth-data-dir <path>', 'persist the pglite auth store here (dev; else in-memory)')
    .option(
      '--enc-key <base64>',
      'base64 32-byte AES-256 key for DB-backed secret encryption (enables multi-tenancy; else ONEC_MCP_ENC_KEY)',
    )
    .action(async (opts: ServeOptions) => {
      const dataDir = resolveDataDir(process.env, opts.dataDir)
      const insecure = opts.insecureStorage === true
      const port = parsePort(opts.port)
      const source = new FileConnectionSource({ dataDir, insecure })

      const publicUrl = opts.publicUrl ?? process.env.ONEC_MCP_PUBLIC_URL
      // Fold the public origin's Host into the DNS-rebinding allowlist so a reverse
      // proxy forwarding the original Host needs no separate ONEC_MCP_ALLOWED_HOSTS.
      const allowedHosts = resolveAllowedHosts(process.env, opts.host, port, publicUrl)
      let auth: NonNullable<Parameters<typeof createHttpServer>[0]['auth']> | undefined
      if (publicUrl !== undefined && publicUrl !== '') {
        // `||` not `??`: an empty-string BETTER_AUTH_SECRET (e.g. `${VAR}` with the
        // host var unset) must fall through to AUTH_SECRET, not shadow it.
        const secret = process.env.BETTER_AUTH_SECRET || process.env.AUTH_SECRET
        if (secret === undefined || secret === '') {
          throw new Error('BETTER_AUTH_SECRET is required when --public-url enables auth')
        }
        // Multi-tenancy is opt-in on the auth path: supply a KEK (flag or env) to
        // switch from the file source to DB-backed, per-user-scoped bases. Absent
        // → auth without tenancy (Slice-2 file source).
        const keyring = resolveKeyring(process.env, opts)
        const dialect = resolveDialect(process.env, opts)
        // Tenancy stores admins, grants, and AES-GCM-encrypted 1С secrets in this
        // DB. An in-memory pglite (no --pg-url/DATABASE_URL, no --auth-data-dir) is
        // wiped on every restart — silently losing them AND reopening /setup on the
        // public URL. Refuse it, mirroring the admin-create/set-password guards.
        if (keyring !== undefined && dialect.kind === 'pglite' && dialect.dataDir === undefined) {
          throw new Error(
            'Multi-tenancy (--enc-key / ONEC_MCP_ENC_KEY) needs a PERSISTENT auth store, else every ' +
              'restart wipes admins + encrypted base secrets and reopens /setup. ' +
              'Set --pg-url / DATABASE_URL, or --auth-data-dir / ONEC_MCP_AUTH_DATA_DIR.',
          )
        }
        auth = {
          publicUrl,
          dialect,
          secret,
          ...(keyring !== undefined ? { keyring } : {}),
        }
      }

      const { server, close } = await createHttpServer({
        source,
        dataDir,
        allowedHosts,
        ...(auth !== undefined ? { auth } : {}),
      })
      server.on('error', (err: Error) => {
        logger.error({ err: err.message }, 'HTTP server error')
        // A listen failure (EADDRINUSE / EACCES) must not exit 0 — set a non-zero
        // exit code so an orchestrator/CI sees the boot failure. `close()` is
        // idempotent, so this is safe alongside the SIGINT/SIGTERM path.
        process.exitCode = 1
        void close()
      })
      server.listen(port, opts.host, () => {
        logger.info(
          { host: opts.host, port, dataDir, allowedHosts, auth: auth !== undefined },
          'MCP HTTP server listening',
        )
      })
      // Graceful shutdown: stop accepting connections, then drain the auth store
      // (pg pool). Once both close, the event loop empties and the process exits.
      const shutdown = (sig: NodeJS.Signals): void => {
        logger.info({ sig }, 'shutting down')
        server.close(() => {
          void close()
        })
        // Close only IDLE keep-alive sockets so `server.close` resolves promptly
        // (an idle undici keep-alive would otherwise hold it open to the
        // orchestrator's finite SIGTERM→SIGKILL window, ~10s under compose).
        // Active requests keep their sockets and drain normally — do NOT use
        // closeAllConnections(), which would abort an in-flight /setup or admin write.
        server.closeIdleConnections()
      }
      process.once('SIGINT', () => shutdown('SIGINT'))
      process.once('SIGTERM', () => shutdown('SIGTERM'))
    })

  program
    .command('admin-create')
    .description(
      'Bootstrap the FIRST admin user directly in the auth store (header-less seed; no admin session required)',
    )
    .requiredOption('--email <email>', 'admin email')
    .requiredOption('--password <password>', 'admin password')
    .option('--name <name>', 'display name', 'Admin')
    .option('--public-url <url>', 'external https origin (else ONEC_MCP_PUBLIC_URL)')
    .option('--pg-url <url>', 'Postgres connection string for the auth store (else DATABASE_URL; else pglite)')
    .option('--auth-data-dir <path>', 'persist the pglite auth store here (must match `serve`)')
    .option('--force', 'create the admin even if one already exists (bypasses the bootstrap-only guard)')
    .action(async (opts: AdminCreateOptions) => {
      const publicUrl = opts.publicUrl ?? process.env.ONEC_MCP_PUBLIC_URL
      if (publicUrl === undefined || publicUrl === '') {
        throw new Error('--public-url (or ONEC_MCP_PUBLIC_URL) is required')
      }
      // `||` not `??`: an empty-string BETTER_AUTH_SECRET must fall through to AUTH_SECRET.
      const secret = process.env.BETTER_AUTH_SECRET || process.env.AUTH_SECRET
      if (secret === undefined || secret === '') {
        throw new Error('BETTER_AUTH_SECRET is required')
      }
      const dialect = resolveDialect(process.env, { ...opts, port: '', host: '' } as ServeOptions)
      // A bootstrapped admin must OUTLIVE this process. An in-memory pglite (no
      // --pg-url/DATABASE_URL and no --auth-data-dir/ONEC_MCP_AUTH_DATA_DIR) is
      // discarded on close, so the admin would vanish before any `serve` — a silent
      // no-op. Require a persistent store and fail loudly instead.
      if (dialect.kind === 'pglite' && dialect.dataDir === undefined) {
        throw new Error(
          'admin-create needs a PERSISTENT auth store, else the admin is lost when this process exits. ' +
            'Pass --pg-url (or DATABASE_URL), or --auth-data-dir (or ONEC_MCP_AUTH_DATA_DIR) matching your `serve`.',
        )
      }
      const dbHandle = createDb(dialect)
      try {
        await runAuthMigrations(dbHandle)
        // Bootstrap-only by contract (the README calls this the CLI equivalent of the
        // one-time /setup wizard, which self-closes once an admin exists). This call
        // bypasses every session check, so without a gate a repeat run — or two racing
        // ones — would silently mint extra admins. The sanctioned way to add an admin
        // afterwards is the /admin panel: an existing admin promotes a user.
        if (opts.force !== true && (await countAdmins(dbHandle.db)) > 0) {
          throw new Error(
            'An administrator already exists — admin-create is for the initial bootstrap only. ' +
              'Promote a user from the /admin panel instead, or pass --force to add one anyway.',
          )
        }
        const auth = buildAuth({ urls: resolveCanonicalUrls(publicUrl), db: dbHandle.db, secret })
        // Header-less call: session is null and (ctx.request || ctx.headers) is
        // falsy, so both the create-check and the set-role check are skipped —
        // the ONLY sanctioned first-admin seed (better-auth has no CLI for this).
        const { user } = await auth.api.createUser({
          body: { email: opts.email, password: opts.password, name: opts.name ?? 'Admin', role: 'admin' },
        })
        logger.info({ id: user.id, email: user.email }, 'admin user created')
      } finally {
        await dbHandle.close()
      }
    })

  program
    .command('set-password')
    .description(
      "Break-glass: reset an existing user's password directly in the auth store (no session; for a forgotten password)",
    )
    .requiredOption('--email <email>', 'email of the user to update')
    .requiredOption('--password <password>', 'the new password')
    .option('--public-url <url>', 'external https origin (else ONEC_MCP_PUBLIC_URL)')
    .option('--pg-url <url>', 'Postgres connection string for the auth store (else DATABASE_URL; else pglite)')
    .option('--auth-data-dir <path>', 'persist the pglite auth store here (must match `serve`)')
    .action(async (opts: SetPasswordOptions) => {
      const publicUrl = opts.publicUrl ?? process.env.ONEC_MCP_PUBLIC_URL
      if (publicUrl === undefined || publicUrl === '') {
        throw new Error('--public-url (or ONEC_MCP_PUBLIC_URL) is required')
      }
      // `||` not `??`: an empty-string BETTER_AUTH_SECRET must fall through to AUTH_SECRET.
      const secret = process.env.BETTER_AUTH_SECRET || process.env.AUTH_SECRET
      if (secret === undefined || secret === '') {
        throw new Error('BETTER_AUTH_SECRET is required')
      }
      const dialect = resolveDialect(process.env, { ...opts, port: '', host: '' } as ServeOptions)
      // Same guard as admin-create: an in-memory pglite is discarded on close, so a
      // password reset against it would be a silent no-op. Require a PERSISTENT store.
      if (dialect.kind === 'pglite' && dialect.dataDir === undefined) {
        throw new Error(
          'set-password needs a PERSISTENT auth store (the SAME one your `serve` uses). ' +
            'Pass --pg-url (or DATABASE_URL), or --auth-data-dir (or ONEC_MCP_AUTH_DATA_DIR).',
        )
      }
      const dbHandle = createDb(dialect)
      try {
        await runAuthMigrations(dbHandle)
        const auth = buildAuth({ urls: resolveCanonicalUrls(publicUrl), db: dbHandle.db, secret })
        // The admin plugin's setUserPassword/listUsers require an admin SESSION and
        // 401 on this header-less path, so drive the SAME internal adapter + hasher
        // they use under the hood. `$context` is a promise on the better-auth
        // instance; it is not part of our exported `Auth` alias (the inferred type is
        // not .d.ts-portable), so reach it through a narrowly-typed cast.
        const ctx = (await (auth as unknown as { $context: Promise<AuthContext> }).$context) satisfies AuthContext
        const found = await ctx.internalAdapter.findUserByEmail(opts.email)
        if (found === null) {
          // Fail loudly — never create a user here (that is admin-create's job).
          throw new Error(`No user with email ${JSON.stringify(opts.email)} in the auth store.`)
        }
        const userId = found.user.id
        const hashed = await ctx.password.hash(opts.password)
        const accounts = await ctx.internalAdapter.findAccounts(userId)
        const credential = accounts.find((a) => a.providerId === 'credential')
        if (credential !== undefined) {
          await ctx.internalAdapter.updatePassword(userId, hashed)
        } else {
          // No password account yet (e.g. an SSO-only user) — create the credential.
          await ctx.internalAdapter.createAccount({
            userId,
            providerId: 'credential',
            accountId: userId,
            password: hashed,
          })
        }
        logger.info({ id: userId, email: opts.email }, 'password updated')
      } finally {
        await dbHandle.close()
      }
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
