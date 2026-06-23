import { InvalidArgumentError } from '@1c-odata/client'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { loadConfig, type StoredConnection } from '../config.js'
import type { ConnectionPool } from '../connection-pool.js'
import {
  assertAddable,
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
): Promise<ToolResultBody> {
  const { connection, baseUrl, login, serverTimezone, label, password, overwrite } = args
  const hasPassword = password !== undefined && password !== ''
  // Preflight the duplicate check BEFORE verifying, so a password is never sent
  // to baseUrl only to be rejected as "already exists" afterwards.
  assertAddable(opts.dataDir, connection, overwrite === true)
  // Verify before persisting when a password is available. The password is used
  // verbatim here so verify matches exactly what gets stored/used.
  if (hasPassword) {
    await verifyConnectivity({ baseUrl, login, password: password as string })
  }
  const result = await upsertConnection({
    dataDir: opts.dataDir,
    name: connection,
    baseUrl,
    login,
    serverTimezone: serverTimezone ?? 'Europe/Moscow',
    ...(label !== undefined ? { label } : {}),
    ...(hasPassword ? { password } : {}),
    insecure: opts.insecure ?? false,
    overwrite: overwrite === true,
  })
  pool.refresh(connection)
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
 * Returns whether a verification actually ran (false when no password resolves).
 */
async function verifyCredentialChange(
  opts: ManagementToolsOptions,
  existing: StoredConnection,
  connection: string,
  change: CredentialChange,
): Promise<boolean> {
  const store = new SecretStore({ dataDir: opts.dataDir, insecure: opts.insecure ?? false })
  const effectivePassword = change.password ?? (await store.read(connection))?.password
  if (effectivePassword === undefined) return false
  await verifyConnectivity({
    baseUrl: existing.baseUrl,
    login: change.login ?? existing.login,
    password: effectivePassword,
  })
  return true
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
): Promise<ToolResultBody> {
  const change = parseCredentialChange(login, password)
  if (change.login === undefined && change.password === undefined) {
    throw new InvalidArgumentError('Provide a new login, a new password, or both', { argument: 'login' })
  }
  const existing = loadConfig(opts.dataDir).connections[connection]
  if (existing === undefined) {
    throw new InvalidArgumentError(`No connection named "${connection}"`, { argument: 'connection' })
  }
  const verified = await verifyCredentialChange(opts, existing, connection, change)
  const result = await updateConnectionCredentials({
    dataDir: opts.dataDir,
    name: connection,
    ...(change.login !== undefined ? { login: change.login } : {}),
    ...(change.password !== undefined ? { password: change.password } : {}),
    insecure: opts.insecure ?? false,
  })
  // Rebuild the cached client (it was wired with the old credentials).
  pool.refresh(connection)
  return summarizeCredentialChange(connection, result, verified)
}

/**
 * Connection-management tools. These WRITE the MCP's own config (not the 1С
 * base — data access stays read-only). A password may be supplied but is
 * write-only: it is stored via SecretStore and no tool ever returns it.
 */
export function registerManagementTools(server: McpServer, pool: ConnectionPool, opts: ManagementToolsOptions): void {
  server.registerTool(
    'add_connection',
    {
      title: 'Add or update a connection',
      description:
        'Add or update a 1С OData connection. Writes the non-secret descriptor (baseUrl/login/timezone/label) to config; a supplied password is stored securely and is never returned by any tool. ⚠ Passing `password` here places it in the model context and transcript — prefer the CLI (`1c-odata-mcp add`) or the ONEC_<NAME>_PASSWORD env var; omit it to save only the non-secret config.',
      inputSchema: {
        connection: z
          .string()
          .describe(
            'Connection name — ASCII, starts with a letter or digit, then letters/digits/"-"/"_" (e.g. "tvip-trade")',
          ),
        baseUrl: z.string().describe('Service root URL, e.g. http://host/base/odata/standard.odata/'),
        login: z.string().describe('Basic-auth username'),
        serverTimezone: z.string().optional().describe('IANA timezone (default Europe/Moscow)'),
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
        overwrite: z.boolean().optional().describe('Replace an existing connection (default false)'),
      },
    },
    async (args) => toolResult(() => addConnection(opts, pool, args)),
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
    async ({ connection }) =>
      toolResult(async () => {
        const removed = await removeConnection({
          dataDir: opts.dataDir,
          name: connection,
          insecure: opts.insecure ?? false,
        })
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
    async ({ connection, label }) =>
      toolResult(async () => {
        const result = await setConnectionLabel({ dataDir: opts.dataDir, name: connection, label })
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
    async ({ connection, login, password }) =>
      toolResult(() => applyCredentialChange(opts, pool, connection, login, password)),
  )
}
