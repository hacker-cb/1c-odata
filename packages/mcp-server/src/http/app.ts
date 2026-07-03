import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import express, { type Express } from 'express'
import { createMcpRouter } from './mcp-route.js'

export interface CreateAppOptions {
  /** Builds a fresh McpServer per session (captures the shared pool + version). */
  buildServer: () => McpServer
}

/**
 * Build the Express app: the stateful MCP endpoint at `/mcp` and a liveness probe
 * at `/healthz`. Exported so tests can `app.listen(0)` on an ephemeral port and
 * drive a real MCP client against a real socket.
 */
export function createApp(opts: CreateAppOptions): Express {
  const app = express()
  app.use(express.json())

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok' })
  })

  app.use('/mcp', createMcpRouter({ buildServer: opts.buildServer }))

  return app
}
