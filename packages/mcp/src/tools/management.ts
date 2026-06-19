import { connectionAuth } from '@1c-odata/client'
import { fetchMetadataXml } from '@1c-odata/metadata'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { type ConnectionPool, DEFAULT_METADATA_TIMEOUT_MS } from '../connection-pool.js'
import { assertAddable, removeConnection, type UpsertConnectionResult, upsertConnection } from '../connections.js'
import { stripUrlUserinfo } from '../redact.js'
import { toolResult } from './_result.js'

export interface ManagementToolsOptions {
  dataDir: string
  insecure?: boolean
}

/** Human-readable password disposition for the add_connection summary. */
function passwordNote(result: UpsertConnectionResult): string {
  if (result.passwordBackend !== undefined) return ` (password stored in ${result.passwordBackend})`
  if (result.passwordCleared === true) return ' (previous password cleared — auth target changed; set a new one)'
  return ' (no password stored)'
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
        'Add or update a 1С OData connection. Writes the non-secret descriptor (baseUrl/login/timezone) to config; a supplied password is stored securely and is never returned by any tool. ⚠ Passing `password` here places it in the model context and transcript — prefer the CLI (`1c-odata-mcp add`) or the ONEC_<NAME>_PASSWORD env var; omit it to save only the non-secret config.',
      inputSchema: {
        connection: z
          .string()
          .describe(
            'Connection name — ASCII, starts with a letter or digit, then letters/digits/"-"/"_" (e.g. "tvip-trade")',
          ),
        baseUrl: z.string().describe('Service root URL, e.g. http://host/base/odata/standard.odata/'),
        login: z.string().describe('Basic-auth username'),
        serverTimezone: z.string().optional().describe('IANA timezone (default Europe/Moscow)'),
        password: z
          .string()
          .optional()
          .describe('Password — see the security note in this tool description. Optional.'),
        overwrite: z.boolean().optional().describe('Replace an existing connection (default false)'),
      },
    },
    async ({ connection, baseUrl, login, serverTimezone, password, overwrite }) =>
      toolResult(async () => {
        const hasPassword = password !== undefined && password !== ''
        // Preflight the duplicate check BEFORE verifying, so a password is never
        // sent to baseUrl only to be rejected as "already exists" afterwards.
        assertAddable(opts.dataDir, connection, overwrite === true)
        // Verify before persisting when a password is available. The password is
        // used verbatim here so verify matches exactly what gets stored/used.
        if (hasPassword) {
          await fetchMetadataXml({
            baseUrl: stripUrlUserinfo(baseUrl.trim()),
            auth: connectionAuth({ auth: { username: login.trim(), password: password as string } }),
            timeout: DEFAULT_METADATA_TIMEOUT_MS,
          })
        }
        const result = await upsertConnection({
          dataDir: opts.dataDir,
          name: connection,
          baseUrl,
          login,
          serverTimezone: serverTimezone ?? 'Europe/Moscow',
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
      }),
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
}
