import { type CliConfig, InvalidArgumentError, validateConnection } from '@1c-odata/client'
import { loadConfig as c12Load } from 'c12'

export interface LoadResult {
  config: CliConfig
  configFile: string
  cwd: string
}

/**
 * Load `1c-odata.config.ts` from the project root using c12.
 *
 * Auto-sources `.env` then `.env.local` (relative to `cwd`) before evaluating
 * the user's config file, so `process.env.ONEC_<NAME>_URL` is available when
 * the config file calls `parseConnectionUrl(process.env.ONEC_<NAME>_URL)`.
 *
 * Validates that:
 *   - a config file is present
 *   - `connections` is a non-empty object
 *   - each connection passes `validateConnection` (baseUrl without userinfo,
 *     non-empty auth, valid IANA serverTimezone)
 *
 * Connection.serverTimezone is required (no default applied). Wrong timezone
 * produces silent DateTime parse drift, so the library forces an explicit
 * choice rather than guessing.
 */
export async function loadConfig(opts: { cwd: string; configFile?: string }): Promise<LoadResult> {
  // Auto-load `.env` then `.env.local` (later overrides earlier) before
  // evaluating the user's config file, matching the convention of Vite,
  // Drizzle Kit, Prisma, etc. Vars become available via `process.env` for
  // the `1c-odata.config.ts` evaluation step. CLI code itself does not read
  // any auth env var — this only sets up the user-config edge.
  const result = await c12Load<CliConfig>({
    cwd: opts.cwd,
    name: '1c-odata',
    dotenv: { fileName: ['.env', '.env.local'] },
    ...(opts.configFile !== undefined ? { configFile: opts.configFile } : {}),
  })
  if (!result.configFile) {
    throw new Error(`No 1c-odata.config.{ts,js,mjs} found in ${opts.cwd}`)
  }
  const config = result.config
  if (!config || !config.connections || Object.keys(config.connections).length === 0) {
    throw new Error(`Config at ${result.configFile} must declare at least one connection`)
  }
  // Delegate per-connection validation to validateConnection. On failure,
  // re-throw as InvalidArgumentError so callers can catch via the typed
  // class identity (C-4 contract). The connection name gets prefixed into
  // the message so the CLI output names the bad record; structured
  // argument/received fields propagate from the inner failure.
  for (const [name, conn] of Object.entries(config.connections)) {
    try {
      validateConnection(conn)
    } catch (e) {
      if (e instanceof InvalidArgumentError) {
        const opts: ConstructorParameters<typeof InvalidArgumentError>[1] = { cause: e }
        if (e.argument !== undefined) opts.argument = e.argument
        if (e.received !== undefined) opts.received = e.received
        throw new InvalidArgumentError(`Connection "${name}": ${e.message}`, opts)
      }
      throw e
    }
  }
  return {
    config,
    configFile: result.configFile,
    cwd: opts.cwd,
  }
}
