import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { type DataShape, InvalidArgumentError } from '@1c-odata/client'
import { writeFileAtomic } from './atomic-write.js'
import { stripUrlUserinfo } from './redact.js'

/**
 * Non-secret connection descriptor as persisted in `config.json`. The password
 * lives elsewhere (env / keychain / 0600 file — see {@link SecretStore}); it is
 * NEVER stored here, so this file is safe to surface to an LLM.
 */
export interface StoredConnection {
  /** Clean service-root URL, no userinfo. */
  baseUrl: string
  /** Basic-auth username (the password is resolved separately at use time). */
  login: string
  /** IANA timezone of the 1С server (e.g. 'Europe/Moscow'). */
  serverTimezone: string
  /**
   * Optional human-readable display label — free-form, may be non-ASCII (e.g.
   * "Торговля ТВИП"). Purely cosmetic: surfaced by `list_connections` / the CLI
   * `list`, never used to resolve anything. Absent ⇒ the connection `name` is
   * shown instead (the migration-safe default — see {@link connectionLabel}).
   */
  label?: string
  /** Optional data-shape overrides forwarded to the client. */
  shape?: DataShape
}

/** Shape of `<dataDir>/config.json`. */
export interface McpConfig {
  connections: Record<string, StoredConnection>
}

const CONFIG_FILE = 'config.json'

/** Application slug — the per-user data dir is named after it. */
const APP_DIR = '1c-odata'

/**
 * Resolve the data directory holding `config.json` + the fallback
 * `credentials.json`. This location is deliberately **agent-independent**: every
 * MCP client (Claude Code, Claude Desktop, Codex, ChatGPT, …) spawns the same
 * `@1c-odata/mcp serve` process and resolves the same directory, so a connection
 * added once (via the CLI) is visible to all of them — no agent should override
 * `ONEC_MCP_DATA_DIR` per-install, or it would fragment that shared config.
 *
 * Resolution order (first non-blank wins; both overrides are trimmed):
 * 1. `dataDirOverride` — the `--data-dir` CLI flag, when given.
 * 2. `ONEC_MCP_DATA_DIR` — env override (sandboxed / portable / CI).
 * 3. A predictable per-user dir, XDG-style on every platform:
 *    - macOS / Linux: `$XDG_CONFIG_HOME/1c-odata` when set to an absolute path,
 *      else `~/.config/1c-odata`.
 *    - Windows: `%APPDATA%\1c-odata`, else `~\AppData\Roaming\1c-odata`.
 *
 * The result is always absolute; resolution throws if it isn't (a relative
 * `--data-dir` / `ONEC_MCP_DATA_DIR`, or no `HOME`/`USERPROFILE` so the default
 * can't anchor) rather than silently writing config + the `0600` credentials
 * file to a CWD-relative path that forks the shared config per launch.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env, dataDirOverride?: string): string {
  const dir = firstNonBlank(dataDirOverride, env.ONEC_MCP_DATA_DIR) ?? defaultDataDir(env)
  if (!isAbsolute(dir)) {
    throw new Error(
      `Resolved data directory ${JSON.stringify(dir)} is not absolute. Set --data-dir / ONEC_MCP_DATA_DIR to an ` +
        'absolute path, or ensure HOME/USERPROFILE is set so the default (~/.config or %APPDATA%) can resolve.',
    )
  }
  return dir
}

/** First of `values` that is defined and non-blank, trimmed; else `undefined`. */
function firstNonBlank(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed !== undefined && trimmed !== '') return trimmed
  }
  return undefined
}

/** Per-user default data dir: XDG on macOS/Linux, `%APPDATA%` on Windows. */
function defaultDataDir(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') {
    const appData = env.APPDATA?.trim()
    if (appData !== undefined && appData !== '') return join(appData, APP_DIR)
    return join(homedir(), 'AppData', 'Roaming', APP_DIR)
  }
  // The XDG Base Directory spec mandates absolute paths; a relative or empty
  // $XDG_CONFIG_HOME is ignored in favour of ~/.config. Trim first so a
  // whitespace-padded absolute path is still honoured (and joined cleanly).
  const xdg = env.XDG_CONFIG_HOME?.trim()
  if (xdg !== undefined && xdg !== '' && isAbsolute(xdg)) return join(xdg, APP_DIR)
  return join(homedir(), '.config', APP_DIR)
}

export function configPath(dataDir: string): string {
  return join(dataDir, CONFIG_FILE)
}

/** Load `config.json`. Returns an empty config when the file is absent. */
export function loadConfig(dataDir: string): McpConfig {
  let raw: string
  try {
    raw = readFileSync(configPath(dataDir), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { connections: {} }
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Malformed JSON in ${configPath(dataDir)} — fix or delete the file.`)
  }
  return normalizeConfig(parsed)
}

/** Coerce parsed JSON into a well-formed {@link McpConfig} (shallow). */
function normalizeConfig(data: unknown): McpConfig {
  if (data === null || typeof data !== 'object') return { connections: {} }
  const connections = (data as { connections?: unknown }).connections
  if (connections === null || typeof connections !== 'object') return { connections: {} }
  // Drop structurally-invalid entries (a hand-edited config may have non-objects
  // or miss required string fields — keeping them would crash later paths) AND
  // entries whose name key fails connection-name validation (a non-ASCII name
  // slugs to an empty, colliding `ONEC__PASSWORD` env var). For valid ones, strip
  // any userinfo the baseUrl might carry (defense in depth).
  const sanitized: Record<string, StoredConnection> = Object.create(null)
  for (const [name, conn] of Object.entries(connections as Record<string, unknown>)) {
    if (!isValidConnectionName(name)) continue
    if (conn === null || typeof conn !== 'object') continue
    const c = conn as Partial<StoredConnection>
    if (typeof c.baseUrl !== 'string' || typeof c.login !== 'string' || typeof c.serverTimezone !== 'string') continue
    // Keep `label` only when it is a non-blank string (a hand-edited config may
    // carry a blank or non-string label); blank ⇒ name fallback at display time.
    const label = typeof c.label === 'string' ? c.label.trim() : ''
    sanitized[name] = {
      baseUrl: stripUrlUserinfo(c.baseUrl),
      login: c.login,
      serverTimezone: c.serverTimezone,
      ...(label !== '' ? { label } : {}),
      ...(c.shape !== undefined ? { shape: c.shape } : {}),
    }
  }
  return { connections: sanitized }
}

/**
 * Connection names must be ASCII so they map to an `ONEC_<NAME>_PASSWORD` env
 * var (a non-ASCII name like a Cyrillic 1С base name would slug to an empty,
 * colliding `ONEC__PASSWORD`). Letters, digits, `-` and `_` are allowed; both
 * `-` and `_` become `_` in the env var, so names differing only in that
 * separator share one override env var (keychain/file storage keys on the exact
 * name and never collide). The name is a user-chosen alias.
 */
const CONNECTION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** Whether `name` is a usable connection alias (see {@link assertValidConnectionName}). */
export function isValidConnectionName(name: string): boolean {
  return CONNECTION_NAME_RE.test(name)
}

export function assertValidConnectionName(name: string): void {
  if (!isValidConnectionName(name)) {
    throw new InvalidArgumentError(
      `Invalid connection name "${name}": use ASCII letters, digits, hyphens and underscores (e.g. "test_tvip_trade"); it maps to a ONEC_<NAME>_PASSWORD env var`,
      { argument: 'name' },
    )
  }
}

/**
 * Effective display label for a connection: its stored {@link StoredConnection.label}
 * when set, else the connection `name`. The name is the migration-safe default —
 * a connection added before labels existed (or with no label) simply shows its
 * name, so no config rewrite is needed to backfill one.
 */
export function connectionLabel(name: string, conn: Pick<StoredConnection, 'label'>): string {
  const label = conn.label?.trim()
  return label !== undefined && label !== '' ? label : name
}

/** Persist `config.json` atomically (tmp + rename), creating `dataDir` if needed. */
export function saveConfig(dataDir: string, config: McpConfig): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileAtomic(configPath(dataDir), `${JSON.stringify(config, null, 2)}\n`)
}
