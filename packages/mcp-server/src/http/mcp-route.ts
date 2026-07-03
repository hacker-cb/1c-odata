import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { type Request, type Response, Router } from 'express'

/** Hard ceiling on concurrent live sessions — a burst of abandoned inits can't OOM the process. */
const DEFAULT_MAX_SESSIONS = 1024

/** The JSON-RPC `id` of a single request, echoed on error responses for client correlation (null otherwise). */
function requestId(body: unknown): string | number | null {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const id = (body as { id?: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') return id
  }
  return null
}

/**
 * The authenticated subject on a bearer-gated request, or undefined (no-auth path).
 * `requireBearerAuth` sets `req.auth` to the verifier's AuthInfo; our verifier puts
 * `sub` on `extra` (see auth/verifier.ts). No auth middleware → `req.auth` absent.
 */
function authSub(req: Request): string | undefined {
  const extra = (req as { auth?: { extra?: Record<string, unknown> } }).auth?.extra
  const sub = extra?.sub
  return typeof sub === 'string' && sub !== '' ? sub : undefined
}

/** One live session: its transport + the subject that opened it (undefined on the no-auth path). */
interface SessionEntry {
  transport: StreamableHTTPServerTransport
  // `| undefined` (not just optional): authSub() yields string | undefined, and
  // under exactOptionalPropertyTypes an optional-only field rejects an explicit
  // undefined value. The no-auth path stores undefined here deliberately.
  sub: string | undefined
}

export interface McpRouteOptions {
  /**
   * Builds a fresh McpServer per session, given the authenticated subject. Auth
   * path: `sub` = req.auth.extra.sub. No-auth path: `sub` undefined → shared pool.
   * `sub: string | undefined` (not optional-only) so the `{ sub }` call site — where
   * `sub` comes from authSub() as `string | undefined` — type-checks under
   * exactOptionalPropertyTypes.
   */
  buildServer: (ctx: { sub: string | undefined }) => McpServer
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
 * Each session is pinned to the `sub` that opened it (auth path). A request whose
 * token `sub` differs from the session owner's is rejected with 403 — a different
 * valid token cannot hijack a session whose McpServer/ScopedPool is closed over the
 * OWNER's grants. On the no-auth path both subs are `undefined` and the check is inert.
 */
export function createMcpRouter(opts: McpRouteOptions): Router {
  const router = Router()
  const transports = new Map<string, SessionEntry>()
  // In-flight initializations not yet registered in `transports`. A session only
  // lands in the map when `onsessioninitialized` fires (during handleRequest), so
  // a burst of concurrent inits would otherwise slip past a `transports.size`-only
  // cap during the `await connect()` gap. Counting these makes the cap immediate.
  let pendingInits = 0
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS
  // When allowedHosts is given, turn on the SDK's Host/Origin validation.
  const rebindGuard =
    opts.allowedHosts !== undefined ? { enableDnsRebindingProtection: true, allowedHosts: opts.allowedHosts } : {}

  /**
   * Resolve the session AND verify the caller owns it. Returns the transport, or
   * undefined after answering (400 unknown session / 403 sub mismatch). Binding a
   * session to its opener's `sub` stops a DIFFERENT valid token from hijacking an
   * already-initialized McpServer whose ScopedPool is closed over the OWNER's sub.
   */
  const resolveOwnedSession = (req: Request, res: Response): StreamableHTTPServerTransport | undefined => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    const entry = sessionId !== undefined ? transports.get(sessionId) : undefined
    if (entry === undefined) {
      res.status(400).send('Invalid or missing session ID')
      return undefined
    }
    // No-auth path: entry.sub === undefined and authSub() === undefined → equal.
    if (entry.sub !== authSub(req)) {
      res.status(403).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Session does not belong to this principal' },
        id: requestId(req.body),
      })
      return undefined
    }
    return entry.transport
  }

  router.post('/', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined

    if (sessionId !== undefined) {
      // Existing-session branch: this is where a hijacker would send tool-calls,
      // so it MUST go through the ownership check.
      const transport = resolveOwnedSession(req, res)
      if (transport === undefined) return
      // express.json() already parsed the body — pass it so the transport does not
      // try to read the (already-consumed) request stream a second time.
      await transport.handleRequest(req, res, req.body)
      return
    }

    if (isInitializeRequest(req.body)) {
      // Cap against live + in-flight sessions (see `pendingInits`).
      if (transports.size + pendingInits >= maxSessions) {
        res.status(503).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Too many active sessions' },
          id: requestId(req.body),
        })
        return
      }
      const sub = authSub(req) // subject that owns this session
      pendingInits += 1
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, { transport, sub })
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
        await opts.buildServer({ sub }).connect(transport as Transport)
        await transport.handleRequest(req, res, req.body)
      } finally {
        // The session (on success) is now in `transports`; drop the in-flight count.
        pendingInits -= 1
      }
      return
    }

    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
      id: requestId(req.body),
    })
  })

  router.get('/', async (req: Request, res: Response) => {
    const transport = resolveOwnedSession(req, res)
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
    const transport = resolveOwnedSession(req, res)
    if (transport === undefined) return
    await transport.handleRequest(req, res)
  })

  return router
}
