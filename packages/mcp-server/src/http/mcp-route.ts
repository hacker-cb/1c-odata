import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { type Request, type Response, Router } from 'express'

export interface McpRouteOptions {
  /** Builds a fresh McpServer for each new session (pool captured by the caller). */
  buildServer: () => McpServer
}

/**
 * A stateful Streamable-HTTP MCP router. One {@link McpServer} +
 * {@link StreamableHTTPServerTransport} per live session, dispatched by the
 * `Mcp-Session-Id` header:
 *   - `POST /`   — client→server JSON-RPC (the `initialize` request opens a session)
 *   - `GET /`    — server→client SSE stream
 *   - `DELETE /` — terminate the session
 *
 * No auth in this slice — mount behind external middleware when needed.
 */
export function createMcpRouter(opts: McpRouteOptions): Router {
  const router = Router()
  const transports = new Map<string, StreamableHTTPServerTransport>()

  router.post('/', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    const existing = sessionId !== undefined ? transports.get(sessionId) : undefined

    let transport: StreamableHTTPServerTransport
    if (existing !== undefined) {
      transport = existing
    } else if (sessionId === undefined && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport)
        },
      })
      transport.onclose = () => {
        const sid = transport.sessionId
        if (sid !== undefined) transports.delete(sid)
      }
      // connect() calls transport.start() and takes ownership of the transport.
      // Cast to Transport: the SDK's StreamableHTTPServerTransport types `onclose`
      // as `(() => void) | undefined`, which trips the repo's exactOptionalPropertyTypes
      // against Transport's exact-optional `onclose?: () => void`. It nominally
      // implements Transport — the mismatch is purely the upstream `| undefined`.
      await opts.buildServer().connect(transport as Transport)
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      })
      return
    }

    // express.json() already parsed the body — pass it so the transport does not
    // try to read the (already-consumed) request stream a second time.
    await transport.handleRequest(req, res, req.body)
  })

  const handleSessionRequest = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    const transport = sessionId !== undefined ? transports.get(sessionId) : undefined
    if (transport === undefined) {
      res.status(400).send('Invalid or missing session ID')
      return
    }
    await transport.handleRequest(req, res)
  }

  router.get('/', handleSessionRequest)
  router.delete('/', handleSessionRequest)

  return router
}
