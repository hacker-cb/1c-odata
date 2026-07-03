import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { type Request, type Response, Router } from 'express'

/** Hard ceiling on concurrent live sessions — a burst of abandoned inits can't OOM the process. */
const DEFAULT_MAX_SESSIONS = 1024

export interface McpRouteOptions {
  /** Builds a fresh McpServer for each new session (pool captured by the caller). */
  buildServer: () => McpServer
  /**
   * `Host`-header values the transport accepts. When set, the SDK's DNS-rebinding
   * protection is enabled, so a browser page (or a hostname rebound to the bound
   * address) whose `Host`/`Origin` is off this allowlist is rejected — a
   * loopback-bound, unauthenticated server can't be driven cross-origin. Omit to
   * disable (e.g. in tests). A reverse-proxy deployment MUST include its public host.
   */
  allowedHosts?: string[]
  /** Max concurrent live sessions; a new `initialize` past this gets 503. Default {@link DEFAULT_MAX_SESSIONS}. */
  maxSessions?: number
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
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS
  // When allowedHosts is given, turn on the SDK's Host/Origin validation.
  const rebindGuard =
    opts.allowedHosts !== undefined ? { enableDnsRebindingProtection: true, allowedHosts: opts.allowedHosts } : {}

  /** Look up the session's transport or answer 400; `undefined` means already answered. */
  const resolveSession = (req: Request, res: Response): StreamableHTTPServerTransport | undefined => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    const transport = sessionId !== undefined ? transports.get(sessionId) : undefined
    if (transport === undefined) {
      res.status(400).send('Invalid or missing session ID')
      return undefined
    }
    return transport
  }

  router.post('/', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    const existing = sessionId !== undefined ? transports.get(sessionId) : undefined

    let transport: StreamableHTTPServerTransport
    if (existing !== undefined) {
      transport = existing
    } else if (sessionId === undefined && isInitializeRequest(req.body)) {
      if (transports.size >= maxSessions) {
        res.status(503).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Too many active sessions' },
          id: null,
        })
        return
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport)
        },
        ...rebindGuard,
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

  router.get('/', async (req: Request, res: Response) => {
    const transport = resolveSession(req, res)
    if (transport === undefined) return
    // The GET stream is the session's long-lived SSE channel. The SDK's `onclose`
    // fires ONLY on an explicit `DELETE /` (1.29), so a client that just drops its
    // socket would otherwise leak its transport + McpServer forever. Reclaim the
    // session when this stream closes. Safe here because no `eventStore` is
    // configured, so sessions are not resumable — a dropped stream means the
    // client must re-initialize anyway.
    res.on('close', () => {
      void transport.close()
    })
    await transport.handleRequest(req, res)
  })

  router.delete('/', async (req: Request, res: Response) => {
    const transport = resolveSession(req, res)
    if (transport === undefined) return
    await transport.handleRequest(req, res)
  })

  return router
}
