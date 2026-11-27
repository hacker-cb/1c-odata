import {
  connectionAuth,
  type DataShape,
  InvalidArgumentError,
  MetadataError,
  validateConnection,
} from '@1c-odata/client'
import { request } from '@1c-odata/client/internal'
import { fetchMetadataXml } from '@1c-odata/metadata'
import { assertValidConnectionName, loadConfig, type StoredConnection, saveConfig, targetBaseUrl } from './config.js'
import { DEFAULT_METADATA_TIMEOUT_MS, DEFAULT_REACHABILITY_TIMEOUT_MS } from './constants.js'
import { stripUrlUserinfo } from './redact.js'
import { connectionEnvPassword, envPassword, passwordEnvVar, SecretStore, secretKey } from './secret-store.js'

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

/** A connection's auth target as stored: the base URL without userinfo, normalized, and the trimmed login. */
function authTarget(baseUrl: string, login: string): { baseUrl: string; login: string } {
  return { baseUrl: targetBaseUrl(baseUrl), login: login.trim() }
}

/** Whether `existing` — normalized as {@link authTarget} normalizes a new one — already points at `next`. */
function sameAuthTarget(existing: StoredConnection, next: { baseUrl: string; login: string }): boolean {
  const stored = authTarget(existing.baseUrl, existing.login)
  return stored.baseUrl === next.baseUrl && stored.login === next.login
}

/** The stored connection `name` — an own entry only, never one the object's prototype answers for (`constructor`). */
function storedConnection(connections: Record<string, StoredConnection>, name: string): StoredConnection | undefined {
  return Object.hasOwn(connections, name) ? connections[name] : undefined
}

/**
 * Who chose an add's target, and what it stores: `byAgent` — an agent through
 * the MCP `add_connection`, which may neither point an existing connection at
 * another base URL or login nor create one under a set `ONEC_<NAME>_PASSWORD`
 * (a person through the CLI may do both); `storesPassword` — whether it stores
 * a password.
 */
export interface AddTarget {
  byAgent: boolean
  storesPassword: boolean
}

/**
 * Throw where an add would send a password somewhere a person did not choose,
 * or store what reads would not use:
 * - an agent pointing an existing connection at another base URL or login —
 *   whatever this process's environment holds, as another MCP process sharing
 *   the config may hold `ONEC_<NAME>_PASSWORD` and would send it there (#253);
 *   a person re-points one with the CLI `add --force`;
 * - an agent creating a connection under a set `ONEC_<NAME>_PASSWORD`: a person
 *   adds that one through the CLI;
 * - pointing elsewhere a connection that takes its password from
 *   `ONEC_<NAME>_PASSWORD` ({@link connectionEnvPassword}) — an overwrite
 *   clears only the stored password, and the env one would go to the new server;
 * - storing a password the connection, as the add leaves it, would not use
 *   for the env one.
 */
function assertAddTargetAllowed(
  name: string,
  existing: StoredConnection | undefined,
  next: { baseUrl: string; login: string },
  add: AddTarget,
): void {
  const envVar = passwordEnvVar(name)
  if (add.byAgent && existing === undefined) {
    if (envPassword(name) === undefined) return
    throw new InvalidArgumentError(
      `The password of connection "${name}" would come from ${envVar}, which is set: a connection under this name is added through the CLI (\`1c-odata-mcp add\`), not by an agent, so that a person chooses where that password goes.`,
      { argument: 'connection' },
    )
  }
  if (add.byAgent && existing !== undefined && !sameAuthTarget(existing, next)) {
    throw new InvalidArgumentError(
      `add_connection does not point the existing connection "${name}" at another server or login: a person re-points it with the CLI (\`1c-odata-mcp add ${name} --force\`). Add the new target under another connection name instead.`,
      { argument: changedTargetArgument(existing, next) },
    )
  }
  // A stored password is judged on the connection as written — a person's add
  // drops an agent's mark, so the env var applies to it again — and a re-point on
  // the connection as it stands: only a password it takes now would follow it.
  if (add.storesPassword && connectionEnvPassword(name, add.byAgent ? existing : undefined) !== undefined) {
    throw new InvalidArgumentError(
      `The password of connection "${name}" comes from ${envVar}, which outranks a stored one: reads would keep sending it, not the password given here. Change or unset ${envVar} instead.`,
      { argument: 'password' },
    )
  }
  if (
    existing !== undefined &&
    connectionEnvPassword(name, existing) !== undefined &&
    !sameAuthTarget(existing, next)
  ) {
    throw new InvalidArgumentError(
      `The password of connection "${name}" comes from ${envVar}; pointing the connection at another server or login would send that password there. Unset ${envVar} first, or add the new target under another connection name.`,
      { argument: changedTargetArgument(existing, next) },
    )
  }
}

/** Which half of the auth target an add changes: `baseUrl`, else `login`. */
function changedTargetArgument(existing: StoredConnection, next: { baseUrl: string; login: string }): string {
  return authTarget(existing.baseUrl, existing.login).baseUrl !== next.baseUrl ? 'baseUrl' : 'login'
}

/**
 * Preflight for an add, BEFORE its credentials are verified — see
 * {@link assertAddTargetAllowed} for what it refuses. {@link upsertConnection}
 * re-checks under the config lock.
 */
export function assertAddTargetAllowedOnAdd(
  dataDir: string,
  name: string,
  next: { baseUrl: string; login: string },
  add: AddTarget,
): void {
  const existing = storedConnection(loadConfig(dataDir).connections, name)
  assertAddTargetAllowed(name, existing, authTarget(next.baseUrl, next.login), add)
}

/**
 * Throw where connection `name`, stored as `conn`, takes its password from
 * `ONEC_<NAME>_PASSWORD` ({@link connectionEnvPassword}): that outranks a
 * stored password on read, so a credential change would neither be used nor —
 * verified against the new pair — be what the reads send. Checked before
 * verifying and again by {@link updateConnectionCredentials}.
 */
export function assertNoEnvPassword(name: string, conn: StoredConnection): void {
  if (connectionEnvPassword(name, conn) === undefined) return
  const envVar = passwordEnvVar(name)
  throw new InvalidArgumentError(
    `The password of connection "${name}" comes from ${envVar}, which outranks a stored one: reads would keep sending it whatever is changed here. Change or unset ${envVar} instead.`,
    { argument: 'connection' },
  )
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
  if (!overwrite && storedConnection(connections, name) !== undefined) {
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
  /**
   * IANA timezone of the 1С server. No default: required for a new connection,
   * and for an overwrite moving it to another base URL; an overwrite keeping
   * the base URL keeps the stored one where it is omitted ({@link addTimezone}).
   */
  serverTimezone?: string
  /**
   * Optional display label. A non-blank value is stored; blank/omitted keeps any
   * existing label on overwrite (use {@link setConnectionLabel} to clear one).
   */
  label?: string
  shape?: DataShape
  /** Stored via {@link SecretStore} when set; omit to write only the non-secret config. */
  password?: string
  insecure?: boolean
  /** Replace an existing connection. Default `false` → throws if it exists. */
  overwrite?: boolean
  /**
   * Whether an agent chose the target — the MCP `add_connection` (default
   * `false`: a person, through the CLI). An agent's add may not re-point an
   * existing connection nor create one under a set `ONEC_<NAME>_PASSWORD`, and
   * a connection it creates is marked `addedBy: 'agent'`, which never takes the
   * env password (#253).
   */
  byAgent?: boolean
  /**
   * Aborted by the time the write's turn comes, nothing is written (#236). A
   * write once begun completes: the secret and the config are never left to
   * disagree.
   */
  signal?: AbortSignal
}

export interface UpsertConnectionResult {
  overwritten: boolean
  passwordBackend?: 'keychain' | 'file'
  /** True when a stale secret was dropped because a passwordless overwrite changed the auth target. */
  passwordCleared?: boolean
}

/**
 * Apply the secret-store side of an upsert, for the connection as `written`,
 * BEFORE the config is saved: write the new password under its key; or — on a
 * passwordless overwrite that changes the auth target (baseUrl/login), or the
 * key its password lives under (a person's add over an agent's connection,
 * {@link secretKey}) — drop the stale secret `written` would read, so a password
 * stored for another target or another hand is never sent to this one. Where
 * the key changes, `existing`'s own key is left for {@link dropOldKey} once the
 * config no longer reads it.
 */
async function applyUpsertSecret(
  store: SecretStore,
  name: string,
  password: string | undefined,
  existing: StoredConnection | undefined,
  written: StoredConnection,
): Promise<{ passwordBackend?: 'keychain' | 'file'; passwordCleared: boolean }> {
  if (password !== undefined && password !== '') {
    return { passwordBackend: (await store.write(name, password, written)).backend, passwordCleared: false }
  }
  if (existing === undefined) return { passwordCleared: false }
  if (secretKey(name, existing) !== secretKey(name, written) || !sameAuthTarget(existing, written)) {
    // Fail closed: a password left behind would go to the new target once read again.
    await store.remove(name, { strict: true }, written)
    return { passwordCleared: true }
  }
  return { passwordCleared: false }
}

/**
 * After the config is saved: drop, best-effort, the password `existing` kept
 * under a key the connection no longer reads ({@link secretKey}) — never read
 * again for it, so a failure only leaves it behind.
 */
async function dropOldKey(
  store: SecretStore,
  name: string,
  existing: StoredConnection | undefined,
  written: StoredConnection,
): Promise<void> {
  if (existing === undefined || secretKey(name, existing) === secretKey(name, written)) return
  try {
    await store.remove(name, {}, existing)
  } catch {
    // Left behind under its own key, where nothing reads it for this connection.
  }
}

/**
 * Build the stored descriptor. A non-blank `input.label` sets/replaces the label;
 * otherwise an existing label is preserved (so an unrelated overwrite — e.g. a
 * timezone fix — doesn't drop one set via {@link setConnectionLabel}; clearing is
 * done there). `shape` likewise: neither `add` nor `add_connection` takes one, so
 * an overwrite keeps the stored one, re-pointed or not (#256). `addedBy: 'agent'` marks a connection an agent created, and stays
 * on one it only overwrites (it cannot re-point it); a person's add drops it.
 */
function buildStoredConnection(
  next: { baseUrl: string; login: string; serverTimezone: string },
  input: Pick<UpsertConnectionInput, 'label' | 'shape'>,
  existing: StoredConnection | undefined,
  byAgent: boolean,
): StoredConnection {
  const label = input.label?.trim()
  const resolvedLabel = label !== undefined && label !== '' ? label : existing?.label
  const shape = input.shape ?? existing?.shape
  const agentTarget = byAgent && (existing === undefined || existing.addedBy === 'agent')
  return {
    baseUrl: next.baseUrl,
    login: next.login,
    serverTimezone: next.serverTimezone,
    ...(resolvedLabel !== undefined && resolvedLabel !== '' ? { label: resolvedLabel } : {}),
    ...(shape !== undefined ? { shape } : {}),
    ...(agentTarget ? { addedBy: 'agent' as const } : {}),
  }
}

/**
 * The timezone an add of `name` stores: the one given; else, for an overwrite
 * keeping `existing` on the same base URL, the stored one. Anything else throws
 * — there is no default: a wrong zone silently shifts every DateTime (#254).
 */
export function addTimezone(
  name: string,
  existing: StoredConnection | undefined,
  baseUrl: string,
  given: string | undefined,
): string {
  const zone = given?.trim()
  const keepsUrl =
    existing !== undefined && authTarget(existing.baseUrl, '').baseUrl === authTarget(baseUrl, '').baseUrl
  if (zone !== undefined) {
    if (zone !== '') return zone
    throw new InvalidArgumentError(
      `The server timezone (serverTimezone / --timezone) of "${name}" is blank: give an IANA zone, e.g. Europe/Moscow or Asia/Yekaterinburg${keepsUrl ? ', or omit it to keep the stored one' : ''}.`,
      { argument: 'serverTimezone' },
    )
  }
  if (keepsUrl) {
    // Trimmed, as a given one is: a hand-written " Europe/Moscow " would pass the check and fail every read.
    return existing.serverTimezone.trim()
  }
  const what =
    existing === undefined
      ? `the new connection "${name}"`
      : `connection "${name}" when it moves to another server, which may run in another zone`
  throw new InvalidArgumentError(
    `The server timezone (serverTimezone / --timezone) is required for ${what}: the IANA zone of its 1С server, e.g. Europe/Moscow or Asia/Yekaterinburg — ask the person if unknown. There is no default: a wrong zone silently shifts every DateTime.`,
    { argument: 'serverTimezone' },
  )
}

/**
 * Preflight for an add, BEFORE its credentials are verified: the timezone it
 * would store ({@link addTimezone}) and the fields {@link assertConnectionFields}
 * checks, so a missing or mistyped zone fails without a `$metadata` download.
 */
export function assertAddFieldsOnAdd(
  dataDir: string,
  name: string,
  input: { baseUrl: string; login: string; serverTimezone?: string | undefined; password?: string | undefined },
): void {
  const existing = storedConnection(loadConfig(dataDir).connections, name)
  const serverTimezone = addTimezone(name, existing, input.baseUrl, input.serverTimezone)
  assertConnectionFields({
    baseUrl: input.baseUrl,
    login: input.login,
    serverTimezone,
    ...(input.password !== undefined ? { password: input.password } : {}),
  })
}

/**
 * Throw where {@link upsertConnection} would refuse these fields — a base URL,
 * login or timezone (an IANA zone) that is not valid — so a caller checks them
 * BEFORE it spends a `$metadata` download verifying them. When only the
 * non-secret config is saved, a placeholder satisfies `validateConnection`'s
 * non-empty password check; it is never persisted.
 */
export function assertConnectionFields(input: {
  baseUrl: string
  login: string
  serverTimezone: string
  password?: string
}): void {
  const { baseUrl, login } = authTarget(input.baseUrl, input.login)
  const password = input.password !== undefined && input.password !== '' ? input.password : 'x'
  validateConnection({ baseUrl, auth: { username: login, password }, serverTimezone: input.serverTimezone.trim() })
}

/**
 * Validate and persist a connection: writes the non-secret descriptor to
 * `config.json` and, when a password is given, stores it via {@link SecretStore}.
 * Shared by the CLI `add` command and the MCP `add_connection` tool. Pure config
 * I/O — callers verify connectivity separately if they want to.
 */
export async function upsertConnection(input: UpsertConnectionInput): Promise<UpsertConnectionResult> {
  assertValidConnectionName(input.name)
  const { baseUrl, login } = authTarget(input.baseUrl, input.login)
  const password = input.password // opaque credential — stored verbatim, never trimmed

  return withConfigLock(async () => {
    input.signal?.throwIfAborted()
    const config = loadConfig(input.dataDir)
    const existing = storedConnection(config.connections, input.name)
    const existed = existing !== undefined
    if (existed && input.overwrite !== true) {
      throw new InvalidArgumentError(`Connection "${input.name}" already exists`, { argument: 'name' })
    }
    // Trimmed (non-interactive --timezone / MCP tool args aren't trimmed by their
    // callers): surrounding whitespace would fail the IANA check.
    const serverTimezone = addTimezone(input.name, existing, baseUrl, input.serverTimezone)
    assertConnectionFields({ ...input, serverTimezone })

    // Authoritative (under the lock) re-checks of the env-var guards.
    assertNoPasswordEnvCollision(config.connections, input.name)
    const byAgent = input.byAgent === true
    assertAddTargetAllowed(
      input.name,
      existing,
      { baseUrl, login },
      { byAgent, storesPassword: password !== undefined && password !== '' },
    )

    // Mutate the secret store BEFORE persisting config: if a secret write/remove
    // throws, config.json is left untouched, so it can never end up pointing at a
    // new auth target (baseUrl/login) while a stale password still resolves.
    const written = buildStoredConnection({ baseUrl, login, serverTimezone }, input, existing, byAgent)
    const store = new SecretStore({ dataDir: input.dataDir, insecure: input.insecure ?? false })
    const secret = await applyUpsertSecret(store, input.name, password, existing, written)

    config.connections[input.name] = written
    saveConfig(input.dataDir, config)
    await dropOldKey(store, input.name, existing, written)

    return {
      overwritten: existed,
      ...(secret.passwordBackend !== undefined ? { passwordBackend: secret.passwordBackend } : {}),
      ...(secret.passwordCleared ? { passwordCleared: true } : {}),
    }
  })
}

/**
 * Remove a connection from `config.json` and delete its stored password — under
 * the name and, for an agent's connection, under its target's key
 * ({@link secretKey}). Best-effort on the keychain: a password left there is
 * keyed to what it was stored for, and an agent re-creating the connection
 * never reads a person's. Returns false if absent.
 */
export async function removeConnection(input: { dataDir: string; name: string; insecure?: boolean }): Promise<boolean> {
  return withConfigLock(async () => {
    const config = loadConfig(input.dataDir)
    const existing = config.connections[input.name]
    if (existing === undefined) return false
    delete config.connections[input.name]
    saveConfig(input.dataDir, config)
    const store = new SecretStore({ dataDir: input.dataDir, insecure: input.insecure ?? false })
    await store.remove(input.name)
    if (existing.addedBy === 'agent') await store.remove(input.name, {}, existing)
    return true
  })
}

/**
 * Reachability probe: fetch `$metadata` with the given credentials, throwing on
 * an auth/network failure. Kept out of {@link upsertConnection} /
 * {@link updateConnectionCredentials} (which stay pure config + secret I/O) so
 * the add / set-credentials paths can verify a credential pair before — or just
 * after — persisting it, exactly as they choose.
 */
export async function verifyConnectivity(input: {
  baseUrl: string
  login: string
  password: string
  timeout?: number
  /** Aborts the `$metadata` download — an MCP call's own signal, so a cancel stops it (#236). */
  signal?: AbortSignal
}): Promise<void> {
  await fetchMetadataXml({
    baseUrl: stripUrlUserinfo(input.baseUrl.trim()),
    auth: connectionAuth({ auth: { username: input.login.trim(), password: input.password } }),
    timeout: input.timeout ?? DEFAULT_METADATA_TIMEOUT_MS,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  })
}

/**
 * Lightweight reachability + auth probe: GET the OData service ROOT (a small
 * service document) instead of the full multi-MB `$metadata`. A 2xx means the base
 * is reachable AND the credentials are valid; a non-2xx surfaces as a typed
 * HTTPError (401 → `PermissionError`) from the same transport pipeline as
 * {@link verifyConnectivity}, so callers classify auth-vs-network identically.
 *
 * Use this for periodic / on-demand HEALTH checks — on real bases the service root
 * is ~20× smaller than `$metadata` (KB–hundreds of KB vs 10–15 MB), so the probe is
 * far cheaper on the 1С server and stays well under a short timeout even on a slow
 * link. Use {@link verifyConnectivity} when you must also confirm the `$metadata`
 * itself is fetchable/parseable (adding or re-verifying a base).
 */
export async function verifyReachability(input: {
  baseUrl: string
  login: string
  password: string
  timeout?: number
}): Promise<void> {
  // targetBaseUrl strips a trailing slash; the OData service document lives at
  // the root WITH the slash, so re-append it.
  const root = `${targetBaseUrl(input.baseUrl)}/`
  const raw = await request(
    {
      method: 'GET',
      url: root,
      headers: {
        Authorization: connectionAuth({ auth: { username: input.login.trim(), password: input.password } }).header,
        // Prefer JSON but accept the Atom service document too (some servers only
        // serve XML) so the probe doesn't 406 a healthy base.
        Accept: 'application/json, application/xml;q=0.9, */*;q=0.1',
      },
    },
    { timeout: input.timeout ?? DEFAULT_REACHABILITY_TIMEOUT_MS },
  )
  // A 2xx that is NOT an OData service document must not read as healthy (the health
  // job would record `ok` for an invalid URL/credentials). The OData root is either a
  // JSON object/array (`{…}` / `[…]`) or an Atom service document (`<service>` /
  // `<app:service>`, optionally behind an XML declaration / comments). Accept ONLY
  // those shapes — a whitelist, not "reject HTML": an HTML fragment like `<body>…` or
  // a proxy's plain-text page (which a bare `startsWith('<')` would wave through) is
  // rejected too. The message carries no auth keyword, so classifyProbe files it as
  // `unreachable`.
  const head = raw.body
    .replace(/^\uFEFF/, '')
    .trimStart()
    // Bounded like assertEdmxResponse: keep off the multi-MB tail, but large enough
    // that a long XML prolog / leading comments can't push <service> out of range.
    .slice(0, 8192)
    .toLowerCase()
  const looksJson = head.startsWith('{') || head.startsWith('[')
  const looksXmlServiceDoc = /^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:service|app:service)\b/.test(head)
  if (!looksJson && !looksXmlServiceDoc) {
    throw new MetadataError(
      `The service root at ${root} did not return an OData document — the response is neither a JSON nor an XML service document (wrong base URL, or a sign-in portal)`,
      { request: { method: 'GET', url: root } },
    )
  }
}

export interface SetLabelResult {
  /** Effective label after the change — the stored label, or the name when cleared. */
  label: string
  /** True when the stored label was removed (the connection reverts to the name fallback). */
  cleared: boolean
}

/**
 * Set or clear a connection's display label, leaving every other field
 * (incl. credentials) untouched. A blank `label` removes the stored label,
 * reverting to the connection-name fallback. Throws if the connection is absent.
 */
export async function setConnectionLabel(input: {
  dataDir: string
  name: string
  label: string
}): Promise<SetLabelResult> {
  return withConfigLock(async () => {
    const config = loadConfig(input.dataDir)
    const existing = config.connections[input.name]
    if (existing === undefined) {
      throw new InvalidArgumentError(`No connection named "${input.name}"`, { argument: 'connection' })
    }
    const label = input.label.trim()
    if (label === '') {
      delete existing.label
    } else {
      existing.label = label
    }
    saveConfig(input.dataDir, config)
    return { label: label === '' ? input.name : label, cleared: label === '' }
  })
}

export interface UpdateCredentialsInput {
  dataDir: string
  name: string
  /** New username; omit to keep the current one. Trimmed; must be non-empty when given. */
  login?: string
  /** New password; omit to keep the current one. Stored via {@link SecretStore}; never trimmed. */
  password?: string
  insecure?: boolean
  /**
   * Aborted by the time the write's turn comes, nothing is written (#236). A
   * write once begun completes: the secret and the config are never left to
   * disagree.
   */
  signal?: AbortSignal
}

export interface UpdateCredentialsResult {
  /** True when the stored login actually changed (a no-op same-login update reports false). */
  loginUpdated: boolean
  /** True when a new password was written. */
  passwordUpdated: boolean
  /** Backend the new password landed in, when one was written. */
  passwordBackend?: 'keychain' | 'file'
}

/**
 * Change a connection's login and/or password in place, preserving every other
 * descriptor field (baseUrl, timezone, label, shape). At least one of `login` /
 * `password` must be given. The password is keyed on the connection NAME (an
 * agent's connection: the name and its base URL, {@link secretKey}), never the
 * login, so changing the login never orphans it. Pure config + secret I/O —
 * callers verify connectivity separately (see {@link verifyConnectivity}).
 */
export async function updateConnectionCredentials(input: UpdateCredentialsInput): Promise<UpdateCredentialsResult> {
  const login = input.login?.trim()
  if (input.login !== undefined && login === '') {
    throw new InvalidArgumentError('login must not be empty', { argument: 'login' })
  }
  if (input.password !== undefined && input.password === '') {
    throw new InvalidArgumentError('password must not be empty', { argument: 'password' })
  }
  if (login === undefined && input.password === undefined) {
    throw new InvalidArgumentError('Provide a new login, a new password, or both', { argument: 'login' })
  }
  return withConfigLock(async () => {
    input.signal?.throwIfAborted()
    const config = loadConfig(input.dataDir)
    const existing = config.connections[input.name]
    if (existing === undefined) {
      throw new InvalidArgumentError(`No connection named "${input.name}"`, { argument: 'connection' })
    }
    assertNoEnvPassword(input.name, existing)
    // Write the secret BEFORE the config so a login change is never persisted
    // while its matching password write is still pending or has failed.
    const store = new SecretStore({ dataDir: input.dataDir, insecure: input.insecure ?? false })
    let passwordBackend: 'keychain' | 'file' | undefined
    if (input.password !== undefined) {
      passwordBackend = (await store.write(input.name, input.password, existing)).backend
    }
    const loginUpdated = login !== undefined && login !== existing.login
    if (loginUpdated) existing.login = login
    saveConfig(input.dataDir, config)
    return {
      loginUpdated,
      passwordUpdated: input.password !== undefined,
      ...(passwordBackend !== undefined ? { passwordBackend } : {}),
    }
  })
}
