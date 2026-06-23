import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { loadConfig } from '../config.js'
import { toolResult } from './_result.js'

export interface ServerInfoToolOptions {
  /** Resolved server version (same value reported in the MCP `initialize` handshake). */
  version: string
  /** Data directory holding `config.json` + the fallback `credentials.json`. */
  dataDir: string
}

/**
 * Register the read-only `server_info` tool. The MCP `initialize` handshake
 * already carries `serverInfo.version`, but that is host-level metadata the model
 * never sees in-conversation; this tool surfaces the version (plus the data
 * directory and connection count) so the assistant can answer "which version is
 * running / where is the config" directly. Never returns secrets.
 */
export function registerServerInfoTool(server: McpServer, opts: ServerInfoToolOptions): void {
  server.registerTool(
    'server_info',
    {
      title: 'Server info',
      description:
        'Report this 1С OData MCP server: its version (from the package, same as the MCP handshake), the data directory holding config + credentials, and how many connections are configured. Read-only; never returns passwords.',
      inputSchema: {},
    },
    async () =>
      toolResult(async () => {
        const connections = Object.keys(loadConfig(opts.dataDir).connections).length
        return {
          summary: `1c-odata MCP v${opts.version} — ${connections} connection(s) configured (data dir: ${opts.dataDir}).`,
          data: { name: '1c-odata', version: opts.version, dataDir: opts.dataDir, connections },
        }
      }),
  )
}
