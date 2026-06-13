import { type Connection, InvalidArgumentError, validateConnection } from '@1c-odata/client'
import { loadConfig as c12Load } from 'c12'

/**
 * A single codegen target — a {@link Connection} plus build-only options. The
 * connection is the same runtime descriptor the application uses; the target
 * *wraps* it with codegen settings rather than dissolving its fields, so
 * runtime/secret config and build config stay separable.
 *
 * @public
 */
export interface CodegenTarget {
  /**
   * Runtime connection descriptor for this base. Used by `1c-odata fetch` to
   * download `$metadata`; its `shape` is baked into the emitted
   * `__metadata.json` by `1c-odata generate`.
   */
  connection: Connection
  /** Whitelist of entity-type names. Globs supported (`Catalog_*`). Closure auto-expands. */
  include?: string[]
  /** Per-target override of `fetchTimeout` (ms) for `1c-odata fetch`. */
  fetchTimeout?: number
}

/**
 * Top-level codegen config — what `1c-odata.config.ts` exports. Consumed only
 * by the `1c-odata` CLI (`fetch` + `generate`). The application runtime builds
 * its {@link Connection}s directly (e.g. via `defineConnection`) and never
 * imports this file, so build-time settings and secrets stay out of the
 * runtime graph.
 *
 * @public
 */
export interface CodegenConfig {
  /** Directory for `<target>.xml` snapshots. Default: `./metadata`. */
  metadataDir?: string
  /** Directory for generated TS files. Default: `./generated`. */
  generatedDir?: string
  /** Default timeout for `1c-odata fetch` (ms). Default: `120_000`. */
  fetchTimeout?: number
  /** Map of target name → codegen target. */
  targets: Record<string, CodegenTarget>
}

/**
 * Identity helper for a type-safe `1c-odata.config.ts`. Preserves literal
 * types via `const` inference, so `targets` keeps its keys narrow.
 *
 * @example
 * ```ts
 * import { defineCodegenConfig } from '@1c-odata/cli'
 * import { parseConnectionUrl } from '@1c-odata/client'
 *
 * const url = process.env.ONEC_URL
 * if (!url) throw new Error('Set ONEC_URL env var')
 *
 * export default defineCodegenConfig({
 *   targets: {
 *     trade: {
 *       connection: { ...parseConnectionUrl(url), serverTimezone: 'Europe/Moscow' },
 *       include: ['Catalog_*', 'Document_*'],
 *     },
 *   },
 * })
 * ```
 *
 * @public
 */
export function defineCodegenConfig<const C extends CodegenConfig>(c: C): C {
  return c
}

export interface LoadResult {
  config: CodegenConfig
  configFile: string
  cwd: string
}

/**
 * Validate one codegen target's connection, re-throwing as a prefixed
 * `InvalidArgumentError` so CLI output names the bad record and callers keep
 * the typed class identity (C-4 contract).
 */
function validateTarget(name: string, target: CodegenTarget): void {
  // Name the missing `connection` explicitly — the most likely migration
  // mistake is writing the old flat shape under a target instead of nesting it
  // under `connection:`. A bare validateConnection(undefined) would only say
  // "Connection must be an object", which doesn't point at the fix.
  if (!target || typeof target !== 'object' || target.connection === undefined) {
    throw new InvalidArgumentError(`Target "${name}" must declare a "connection"`, { argument: 'connection' })
  }
  try {
    validateConnection(target.connection)
  } catch (e) {
    if (e instanceof InvalidArgumentError) {
      const opts: ConstructorParameters<typeof InvalidArgumentError>[1] = { cause: e }
      if (e.argument !== undefined) opts.argument = e.argument
      if (e.received !== undefined) opts.received = e.received
      throw new InvalidArgumentError(`Target "${name}": ${e.message}`, opts)
    }
    throw e
  }
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
 *   - `targets` is a non-empty object
 *   - each `target.connection` passes `validateConnection` (baseUrl without
 *     userinfo, non-empty auth, valid IANA serverTimezone)
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
  const result = await c12Load<CodegenConfig>({
    cwd: opts.cwd,
    name: '1c-odata',
    dotenv: { fileName: ['.env', '.env.local'] },
    ...(opts.configFile !== undefined ? { configFile: opts.configFile } : {}),
  })
  if (!result.configFile) {
    throw new Error(`No 1c-odata.config.{ts,js,mjs} found in ${opts.cwd}`)
  }
  const config = result.config
  if (!config || !config.targets || Object.keys(config.targets).length === 0) {
    throw new Error(`Config at ${result.configFile} must declare at least one target`)
  }
  // Validate each target's connection — per-target so CLI output names the
  // bad record (see validateTarget).
  for (const [name, target] of Object.entries(config.targets)) {
    validateTarget(name, target)
  }
  return {
    config,
    configFile: result.configFile,
    cwd: opts.cwd,
  }
}
