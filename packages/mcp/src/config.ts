import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type DataShape, InvalidArgumentError } from '@1c-odata/client'
import envPaths from 'env-paths'
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
  /** Optional data-shape overrides forwarded to the client. */
  shape?: DataShape
}

/** Shape of `<dataDir>/config.json`. */
export interface McpConfig {
  connections: Record<string, StoredConnection>
}

const CONFIG_FILE = 'config.json'

/**
 * Resolve the data directory holding `config.json` + the fallback
 * `credentials.json`. `ONEC_MCP_DATA_DIR` wins (the Claude Code plugin points
 * it at `${CLAUDE_PLUGIN_DATA}`); otherwise the per-OS user config dir
 * (`~/.config/1c-odata`, `~/Library/Application Support/1c-odata`, `%APPDATA%\1c-odata`).
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ONEC_MCP_DATA_DIR
  if (override !== undefined && override.trim() !== '') return override
  return envPaths('1c-odata', { suffix: '' }).config
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
  // Defense in depth: strip any userinfo a hand-edited/migrated config might carry
  // in baseUrl, so it can never reach memory, requests, or tool output.
  const sanitized: Record<string, StoredConnection> = {}
  for (const [name, conn] of Object.entries(connections as Record<string, StoredConnection>)) {
    sanitized[name] =
      conn !== null && typeof conn === 'object' && typeof conn.baseUrl === 'string'
        ? { ...conn, baseUrl: stripUrlUserinfo(conn.baseUrl) }
        : conn
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
export function assertValidConnectionName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new InvalidArgumentError(
      `Invalid connection name "${name}". Use ASCII letters, digits, hyphens and underscores (e.g. "test_tvip_trade"); it maps to a ONEC_<NAME>_PASSWORD env var.`,
      { argument: 'name' },
    )
  }
}

/** Persist `config.json` atomically (tmp + rename), creating `dataDir` if needed. */
export function saveConfig(dataDir: string, config: McpConfig): void {
  mkdirSync(dataDir, { recursive: true })
  const target = configPath(dataDir)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, target)
}
