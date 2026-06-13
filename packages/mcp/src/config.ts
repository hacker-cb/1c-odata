import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DataShape } from '@1c-odata/client'
import envPaths from 'env-paths'

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
  return normalizeConfig(JSON.parse(raw))
}

/** Coerce parsed JSON into a well-formed {@link McpConfig} (shallow). */
function normalizeConfig(data: unknown): McpConfig {
  if (data === null || typeof data !== 'object') return { connections: {} }
  const connections = (data as { connections?: unknown }).connections
  if (connections === null || typeof connections !== 'object') return { connections: {} }
  return { connections: connections as Record<string, StoredConnection> }
}

/** Persist `config.json` atomically (tmp + rename), creating `dataDir` if needed. */
export function saveConfig(dataDir: string, config: McpConfig): void {
  mkdirSync(dataDir, { recursive: true })
  const target = configPath(dataDir)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, target)
}
