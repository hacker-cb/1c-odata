import { type DataShape, InvalidArgumentError, normalizeBaseUrl, validateConnection } from '@1c-odata/client'
import { assertValidConnectionName, loadConfig, type StoredConnection, saveConfig } from './config.js'
import { stripUrlUserinfo } from './redact.js'
import { SecretStore } from './secret-store.js'

/**
 * Serialize config read-modify-write across concurrent calls in this process.
 * MCP tool invocations can run in parallel, so a slow `add_connection` (it
 * verifies connectivity first) must not be clobbered by a `remove_connection`
 * that loaded a stale config and saved over it. In-process only — the MCP
 * server is the single writer; concurrent CLI processes are not coordinated.
 */
let configMutation: Promise<unknown> = Promise.resolve()
function withConfigLock<T>(task: () => Promise<T>): Promise<T> {
  const run = configMutation.then(task, task)
  configMutation = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export interface UpsertConnectionInput {
  dataDir: string
  name: string
  baseUrl: string
  login: string
  serverTimezone: string
  shape?: DataShape
  /** Stored via {@link SecretStore} when set; omit to write only the non-secret config. */
  password?: string
  insecure?: boolean
  /** Replace an existing connection. Default `false` → throws if it exists. */
  overwrite?: boolean
}

export interface UpsertConnectionResult {
  overwritten: boolean
  passwordBackend?: 'keychain' | 'file'
  /** True when a stale secret was dropped because a passwordless overwrite changed the auth target. */
  passwordCleared?: boolean
}

/**
 * Validate and persist a connection: writes the non-secret descriptor to
 * `config.json` and, when a password is given, stores it via {@link SecretStore}.
 * Shared by the CLI `add` command and the MCP `add_connection` tool. Pure config
 * I/O — callers verify connectivity separately if they want to.
 */
export async function upsertConnection(input: UpsertConnectionInput): Promise<UpsertConnectionResult> {
  assertValidConnectionName(input.name)
  const baseUrl = normalizeBaseUrl(stripUrlUserinfo(input.baseUrl.trim()))
  const login = input.login.trim()
  const password = input.password // opaque credential — stored verbatim, never trimmed

  // Validate baseUrl / login / timezone. When only the non-secret config is
  // saved, a placeholder satisfies validateConnection's non-empty password
  // check; it is never persisted.
  validateConnection({
    baseUrl,
    auth: { username: login, password: password !== undefined && password !== '' ? password : 'x' },
    serverTimezone: input.serverTimezone,
  })

  return withConfigLock(async () => {
    const config = loadConfig(input.dataDir)
    const existing = config.connections[input.name]
    const existed = existing !== undefined
    if (existed && input.overwrite !== true) {
      throw new InvalidArgumentError(`Connection "${input.name}" already exists`, { argument: 'name' })
    }

    config.connections[input.name] = {
      baseUrl,
      login,
      serverTimezone: input.serverTimezone,
      ...(input.shape !== undefined ? { shape: input.shape } : {}),
    } satisfies StoredConnection
    saveConfig(input.dataDir, config)

    const store = new SecretStore({ dataDir: input.dataDir, insecure: input.insecure ?? false })
    let passwordBackend: 'keychain' | 'file' | undefined
    let passwordCleared = false
    if (password !== undefined && password !== '') {
      passwordBackend = (await store.write(input.name, password)).backend
    } else if (existing !== undefined && (existing.baseUrl !== baseUrl || existing.login !== login)) {
      // Passwordless overwrite that changes the auth target (baseUrl/login): drop
      // the stale secret so the old credential is never sent to the new endpoint.
      await store.remove(input.name)
      passwordCleared = true
    }
    return {
      overwritten: existed,
      ...(passwordBackend !== undefined ? { passwordBackend } : {}),
      ...(passwordCleared ? { passwordCleared: true } : {}),
    }
  })
}

/** Remove a connection from `config.json` and delete its stored password. Returns false if absent. */
export async function removeConnection(input: { dataDir: string; name: string; insecure?: boolean }): Promise<boolean> {
  return withConfigLock(async () => {
    const config = loadConfig(input.dataDir)
    if (config.connections[input.name] === undefined) return false
    delete config.connections[input.name]
    saveConfig(input.dataDir, config)
    await new SecretStore({ dataDir: input.dataDir, insecure: input.insecure ?? false }).remove(input.name)
    return true
  })
}
