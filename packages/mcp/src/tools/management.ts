import { InvalidArgumentError } from '@1c-odata/client'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { loadConfig, type StoredConnection } from '../config.js'
import type { ConnectionPool } from '../connection-pool.js'
import {
  assertAddable,
  assertAddFieldsOnAdd,
  assertAddTargetAllowedOnAdd,
  assertNoEnvPassword,
  removeConnection,
  setConnectionLabel,
  type UpdateCredentialsResult,
  type UpsertConnectionResult,
  updateConnectionCredentials,
  upsertConnection,
  verifyConnectivity,
} from '../connections.js'
import { SecretStore } from '../secret-store.js'
import { toolResult } from './_result.js'

export interface ManagementToolsOptions {
  dataDir: string
  insecure?: boolean
}

/** Result payload shared by the management tools — the `_result.toolResult` shape. */
interface ToolResultBody {
  summary: string
  data: Record<string, unknown>
}

/** Human-readable password disposition for the add_connection summary. */
function passwordNote(result: UpsertConnectionResult): string {
  if (result.passwordBackend !== undefined) return ` (password stored in ${result.passwordBackend})`
  if (result.passwordCleared === true) return ' (previous password cleared — auth target changed; set a new one)'
  return ' (no password stored)'
}

interface AddConnectionArgs {
  connection: string
  baseUrl: string
  login: string
  // `| undefined` (not just optional) to match the zod-inferred args under
  // exactOptionalPropertyTypes — the tool callback always passes every key.
  serverTimezone?: string | undefined
  label?: string | undefined
  password?: string | undefined
  overwrite?: boolean | undefined
}

/** Body of the `add_connection` tool (extracted to keep the tool callback flat). */
async function addConnection(
  opts: ManagementToolsOptions,
  pool: ConnectionPool,
  args: AddConnectionArgs,
  signal: AbortSignal,
): Promise<ToolResultBody> {
  const { connection, baseUrl, login, serverTimezone, label, password, overwrite } = args
  const hasPassword = password !== undefined && password !== ''
  // Preflight the duplicate check BEFORE verifying, so a password is never sent
  // to baseUrl only to be rejected as "already exists" afterwards.
  assertAddable(opts.dataDir, connection, overwrite === true)
  assertAddTargetAllowedOnAdd(
    opts.dataDir,
    connection,
    { baseUrl, login },
    { byAgent: true, storesPassword: hasPassword },
  )
  // A missing or mistyped zone (or URL) fails here, not after a multi-MB $metadata download.
  assertAddFieldsOnAdd(opts.dataDir, connection, { baseUrl, login, serverTimezone })
  // Verify before persisting when a password is available. The password is used
  // verbatim here so verify matches exactly what gets stored/used.
  if (hasPassword) {
    await verifyConnectivity({ baseUrl, login, password: password as string, signal })
  }
  const result = await upsertConnection({
    dataDir: opts.dataDir,
    name: connection,
    baseUrl,
    login,
    ...(serverTimezone !== undefined ? { serverTimezone } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(hasPassword ? { password } : {}),
    insecure: opts.insecure ?? false,
    overwrite: overwrite === true,
    byAgent: true,
    signal,
  })
  // A password stored or cleared: a pooled client built with the old one must go, also where the
  // new one cannot be read back — the pool keeps an entry whose password reads as none (#274). An
  // overwrite that keeps the password (a label, a timezone) leaves it: the pool sees the rest itself.
  if (result.passwordBackend !== undefined || result.passwordCleared === true) pool.refresh(connection)
  return {
    summary: `Connection "${connection}" ${result.overwritten ? 'updated' : 'added'}${passwordNote(result)}.`,
    data: {
      connection,
      overwritten: result.overwritten,
      passwordStored: result.passwordBackend !== undefined,
      ...(result.passwordBackend !== undefined ? { passwordBackend: result.passwordBackend } : {}),
      ...(result.passwordCleared === true ? { passwordCleared: true } : {}),
    },
  }
}

/** A normalized credential change: only the fields the caller actually wants to set. */
interface CredentialChange {
  login?: string
  password?: string
}

/** Drop blank/omitted fields so `login`/`password` are present only when meaningfully set. */
function parseCredentialChange(login: string | undefined, password: string | undefined): CredentialChange {
  const newLogin = login?.trim()
  return {
    ...(newLogin !== undefined && newLogin !== '' ? { login: newLogin } : {}),
    ...(password !== undefined && password !== '' ? { password } : {}),
  }
}

/**
 * Verify the change before it is persisted, when a full credential pair can be
 * assembled — the new password, or the stored one when only the login changes.
 * Returns whether a verification actually ran (false when no password resolves),
 * and the stored password it used, which the write checks is still the one stored.
 */
async function verifyCredentialChange(
  opts: ManagementToolsOptions,
  existing: StoredConnection,
  connection: string,
  change: CredentialChange,
  signal: AbortSignal,
): Promise<{ verified: boolean; storedPassword?: string | null | undefined }> {
  const store = new SecretStore({ dataDir: opts.dataDir, insecure: opts.insecure ?? false })
  // A login-only change keeps the stored password: what it is now (none: `null`) is checked again under the lock.
  const storedPassword =
    change.password === undefined ? ((await store.read(connection, existing))?.password ?? null) : undefined
  const effectivePassword = change.password ?? storedPassword ?? undefined
  if (effectivePassword === undefined) return { verified: false, storedPassword }
  await verifyConnectivity({
    baseUrl: existing.baseUrl,
    login: change.login ?? existing.login,
    password: effectivePassword,
    signal,
  })
  return { verified: true, storedPassword }
}

function summarizeCredentialChange(
  connection: string,
  result: UpdateCredentialsResult,
  verified: boolean,
): ToolResultBody {
  const changed = [result.loginUpdated ? 'login' : undefined, result.passwordUpdated ? 'password' : undefined]
    .filter(Boolean)
    .join(' + ')
  return {
    summary:
      changed === ''
        ? `No changes for "${connection}" — the supplied login matched the current one.`
        : `Credentials for "${connection}" updated: ${changed}${verified ? ' (verified)' : ''}.`,
    data: {
      connection,
      loginUpdated: result.loginUpdated,
      passwordUpdated: result.passwordUpdated,
      verified,
      ...(result.passwordBackend !== undefined ? { passwordBackend: result.passwordBackend } : {}),
    },
  }
}

/** Body of the `set_credentials` tool (extracted to keep the tool callback flat). */
async function applyCredentialChange(
  opts: ManagementToolsOptions,
  pool: ConnectionPool,
  connection: string,
  login: string | undefined,
  password: string | undefined,
  signal: AbortSignal,
): Promise<ToolResultBody> {
  const change = parseCredentialChange(login, password)
  if (change.login === undefined && change.password === undefined) {
    throw new InvalidArgumentError('Provide a new login, a new password, or both', { argument: 'login' })
  }
  const existing = loadConfig(opts.dataDir).connections[connection]
  if (existing === undefined) {
    throw new InvalidArgumentError(`No connection named "${connection}"`, { argument: 'connection' })
  }
  // Before verifying: the new pair must not be checked, and reported verified, when reads would not use it.
  assertNoEnvPassword(connection, existing)
  const { verified, storedPassword } = await verifyCredentialChange(opts, existing, connection, change, signal)
  const result = await updateConnectionCredentials({
    dataDir: opts.dataDir,
    name: connection,
    ...(change.login !== undefined ? { login: change.login } : {}),
    ...(change.password !== undefined ? { password: change.password } : {}),
    insecure: opts.insecure ?? false,
    // Verified (or decided) against `existing`: refused where another process changed it since (#273).
    expected: { baseUrl: existing.baseUrl, login: existing.login, password: storedPassword },
    signal,
  })
  // The client built with the old credentials goes, also where the new password cannot be read back.
  pool.refresh(connection)
  return summarizeCredentialChange(connection, result, verified)
}

/**
 * Connection-management tools. These WRITE the MCP's own config (not the 1С
 * base — data access stays read-only). A password may be supplied but is
 * write-only: it is stored via SecretStore and no tool ever returns it.
 *
 * The pool compares a connection and its password on every `get` and rebuilds
 * on a change (#274), but keeps an entry whose password reads as none: so a
 * tool drops the pooled client where it stores, clears or removes a password,
 * and leaves it where an overwrite keeps the password — a label costs no
 * `$metadata` download.
 */
export function registerManagementTools(server: McpServer, pool: ConnectionPool, opts: ManagementToolsOptions): void {
  server.registerTool(
    'add_connection',
    {
      title: 'Add or update a connection',
      description:
        'Add or update a 1С OData connection. Writes the non-secret descriptor (baseUrl/login/timezone/label) to config; a supplied password is stored securely and is never returned by any tool. It never points an existing connection at another baseUrl or login — a person re-points one with the CLI `1c-odata-mcp add <name> --force` — and a connection it creates never takes its password from ONEC_<NAME>_PASSWORD (that variable is for a server a person chose): give it a password here or with set_credentials. Where ONEC_<NAME>_PASSWORD is set for the name, this tool refuses to create the connection (a person adds it with the CLI `1c-odata-mcp add`), and — for a connection a person added, which takes that variable — to store a password for it. ⚠ Passing `password` here places it in the model context and transcript — prefer a person adding the connection with the CLI (`1c-odata-mcp add`, where ONEC_<NAME>_PASSWORD may supply it); omit it to save only the non-secret config.',
      inputSchema: {
        connection: z
          .string()
          .describe(
            'Connection name — ASCII, starts with a letter or digit, then letters/digits/"-"/"_" (e.g. "tvip-trade")',
          ),
        baseUrl: z.string().describe('Service root URL, e.g. http://host/base/odata/standard.odata/'),
        login: z.string().describe('Basic-auth username'),
        serverTimezone: z
          .string()
          .optional()
          .describe(
            'IANA zone of the 1С server, e.g. Europe/Moscow, Asia/Yekaterinburg — required for a new connection (no default: a wrong zone silently shifts every DateTime); ask the person if unknown. An overwrite keeping the base URL keeps the stored zone when this is omitted.',
          ),
        label: z
          .string()
          .optional()
          .describe(
            'Human-readable display label shown by list_connections (free-form, may be Cyrillic). Defaults to the name; use set_label to change it later.',
          ),
        password: z
          .string()
          .optional()
          .describe('Password — see the security note in this tool description. Optional.'),
        overwrite: z
          .boolean()
          .optional()
          .describe(
            'Replace an existing connection with the same baseUrl and login — its timezone, label or password (default false)',
          ),
      },
    },
    async (args, { signal }) => toolResult(() => addConnection(opts, pool, args, signal)),
  )

  server.registerTool(
    'remove_connection',
    {
      title: 'Remove a connection',
      description: 'Remove a 1С OData connection from config and delete its stored password.',
      inputSchema: {
        connection: z.string().describe('Connection name (see list_connections)'),
      },
    },
    async ({ connection }, { signal }) =>
      toolResult(async () => {
        const removed = await removeConnection({
          dataDir: opts.dataDir,
          name: connection,
          insecure: opts.insecure ?? false,
          signal,
        })
        // The pool keeps an entry whose password reads as none: one removed and re-added without a
        // password must not go on with the old one.
        pool.refresh(connection)
        return {
          summary: removed ? `Connection "${connection}" removed.` : `No connection named "${connection}".`,
          data: { connection, removed },
        }
      }),
  )

  server.registerTool(
    'set_label',
    {
      title: 'Set a connection label',
      description:
        "Set or clear a connection's human-readable display label (shown by list_connections). Pass an empty label to clear it and fall back to the connection name. Touches only the label — credentials and connectivity are untouched.",
      inputSchema: {
        connection: z.string().describe('Connection name (see list_connections)'),
        label: z
          .string()
          .describe('New display label (free-form, may be Cyrillic). Empty string clears it (reverts to the name).'),
      },
    },
    async ({ connection, label }, { signal }) =>
      toolResult(async () => {
        const result = await setConnectionLabel({ dataDir: opts.dataDir, name: connection, label, signal })
        return {
          summary: result.cleared
            ? `Label for "${connection}" cleared — it falls back to the name "${connection}".`
            : `Label for "${connection}" set to "${result.label}".`,
          data: { connection, label: result.label, cleared: result.cleared },
        }
      }),
  )

  server.registerTool(
    'set_credentials',
    {
      title: 'Change a connection login and/or password',
      description:
        "Change a connection's login and/or password in place, keeping its base URL, timezone and label. Supply either field alone or both together; the password is stored securely and never returned. When a full credential pair can be assembled (the new password, or the stored one when only the login changes), connectivity is verified first and the change is rejected if it fails. ⚠ Passing `password` here places it in the model context and transcript — prefer the CLI (`1c-odata-mcp set-credentials`) or the ONEC_<NAME>_PASSWORD env var.",
      inputSchema: {
        connection: z.string().describe('Connection name (see list_connections)'),
        login: z.string().optional().describe('New basic-auth username. Omit to keep the current one.'),
        password: z
          .string()
          .optional()
          .describe('New password — stored securely, never returned. Omit to keep the current one.'),
      },
    },
    async ({ connection, login, password }, { signal }) =>
      toolResult(() => applyCredentialChange(opts, pool, connection, login, password, signal)),
  )
}
