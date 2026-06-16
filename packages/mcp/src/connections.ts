import { type DataShape, InvalidArgumentError, normalizeBaseUrl, validateConnection } from '@1c-odata/client'
import { assertValidConnectionName, loadConfig, type StoredConnection, saveConfig } from './config.js'
import { stripUrlUserinfo } from './redact.js'
import { passwordEnvVar, SecretStore } from './secret-store.js'

/**
 * Throw if `name`'s password env-var slug collides with a DIFFERENT existing
 * connection: `ONEC_<NAME>_PASSWORD` is shared (e.g. "a-b" and "a_b" both slug to
 * `ONEC_A_B_PASSWORD` and env wins on read), so a colliding new connection could
 * resolve another connection's env password and send it to its own baseUrl.
 */
function assertNoPasswordEnvCollision(connections: Record<string, StoredConnection>, name: string): void {
  const envVar = passwordEnvVar(name)
  const collision = Object.keys(connections).find((other) => other !== name && passwordEnvVar(other) === envVar)
  if (collision !== undefined) {
    throw new InvalidArgumentError(
      `Connection name "${name}" collides with existing "${collision}" on the ${envVar} password env var (names differing only in "-"/"_" share one). Choose a distinct name.`,
      { argument: 'name' },
    )
  }
}

/**
 * Cheap preflight for the add path: reject an invalid name, a duplicate (without
 * `overwrite`), or a password-env-var collision BEFORE the caller verifies
 * connectivity, so a password is never sent to the supplied baseUrl only to fail
 * afterwards. Best-effort and outside the config lock; {@link upsertConnection}
 * re-checks authoritatively under the lock.
 */
export function assertAddable(dataDir: string, name: string, overwrite: boolean): void {
  assertValidConnectionName(name)
  const { connections } = loadConfig(dataDir)
  if (!overwrite && connections[name] !== undefined) {
    throw new InvalidArgumentError(`Connection "${name}" already exists`, { argument: 'name' })
  }
  assertNoPasswordEnvCollision(connections, name)
}

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
  // Trim the timezone too (non-interactive --timezone / MCP tool args aren't
  // trimmed by their callers): surrounding whitespace would fail the IANA check
  // even for an otherwise-valid zone.
  const serverTimezone = input.serverTimezone.trim()
  const password = input.password // opaque credential — stored verbatim, never trimmed

  // Validate baseUrl / login / timezone. When only the non-secret config is
  // saved, a placeholder satisfies validateConnection's non-empty password
  // check; it is never persisted.
  validateConnection({
    baseUrl,
    auth: { username: login, password: password !== undefined && password !== '' ? password : 'x' },
    serverTimezone,
  })

  return withConfigLock(async () => {
    const config = loadConfig(input.dataDir)
    const existing = config.connections[input.name]
    const existed = existing !== undefined
    if (existed && input.overwrite !== true) {
      throw new InvalidArgumentError(`Connection "${input.name}" already exists`, { argument: 'name' })
    }

    // Authoritative (under the lock) re-check of the env-var collision guard.
    assertNoPasswordEnvCollision(config.connections, input.name)

    // Mutate the secret store BEFORE persisting config: if a secret write/remove
    // throws, config.json is left untouched, so it can never end up pointing at a
    // new auth target (baseUrl/login) while a stale password still resolves.
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

    config.connections[input.name] = {
      baseUrl,
      login,
      serverTimezone,
      ...(input.shape !== undefined ? { shape: input.shape } : {}),
    } satisfies StoredConnection
    saveConfig(input.dataDir, config)

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
