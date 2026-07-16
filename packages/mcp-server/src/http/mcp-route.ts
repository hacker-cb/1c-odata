import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { type Request, type Response, Router } from 'express'
import { SessionRegistry, type SessionTuning } from './session-registry.js'

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
  /** Session cap + idle-sweep tuning; every field defaults (see session-registry.ts). */
  sessions?: SessionTuning
}

/** A mounted MCP router plus the {@link SessionRegistry} backing it (exposed so callers can `stop()` its sweeper). */
export interface McpRouter {
  router: Router
  sessions: SessionRegistry
}

/**
 * A stateful Streamable-HTTP MCP router. One {@link McpServer} +
 * {@link StreamableHTTPServerTransport} per live session, dispatched by the
 * `Mcp-Session-Id` header:
 *   - `POST /`   — client→server JSON-RPC (the `initialize` request opens a session)
 *   - `GET /`    — server→client SSE stream
 *   - `DELETE /` — terminate the session
 *
 * Session accounting (per-`sub` quota, global cap, idle reclaim) lives in the
 * {@link SessionRegistry}. Each session is pinned to the `sub` that opened it (auth
 * path). A request whose token `sub` differs from the session owner's is rejected
 * with 403 — a different valid token cannot hijack a session whose McpServer/
 * ScopedPool is closed over the OWNER's grants. On the no-auth path both subs are
 * `undefined` and the check is inert.
 */
export function createMcpRouter(opts: McpRouteOptions): McpRouter {
  const router = Router()
  const sessions = new SessionRegistry(opts.sessions ?? {})
  sessions.start()
  // When allowedHosts is given, turn on the SDK's Host/Origin validation.
  const rebindGuard =
    opts.allowedHosts !== undefined ? { enableDnsRebindingProtection: true, allowedHosts: opts.allowedHosts } : {}

  /**
   * Resolve the session AND verify the caller owns it, stamping activity on success.
   * Returns the transport, or undefined after answering:
   *   - 400 when the `Mcp-Session-Id` header is absent (a malformed non-init request), vs
   *   - 404 when the id is present but unknown — a swept idle session or a post-DELETE
   *     id — so the client re-initializes per the Streamable-HTTP spec (404 = "no such
   *     session, start a new one"; safe because no eventStore ⇒ sessions aren't resumable), vs
   *   - 403 when a DIFFERENT valid token replays the owner's live session id.
   */
  const resolveOwnedSession = (req: Request, res: Response): StreamableHTTPServerTransport | undefined => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    if (sessionId === undefined) {
      res.status(400).send('Missing Mcp-Session-Id header')
      return undefined
    }
    const entry = sessions.get(sessionId)
    if (entry === undefined) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found' },
        id: requestId(req.body),
      })
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
    sessions.touch(sessionId) // an owned request keeps the session fresh so the sweeper won't reap it
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
      const sub = authSub(req) // subject that owns this session
      // Reserve against the global cap AND this sub's quota (both count in-flight
      // inits). undefined → over a cap → 503.
      const reservation = sessions.reserve(sub)
      if (reservation === undefined) {
        res.status(503).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Too many active sessions' },
          id: requestId(req.body),
        })
        return
      }
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            reservation.commit(sid, transport)
          },
          ...rebindGuard,
        })
        transport.onclose = () => {
          const sid = transport.sessionId
          if (sid !== undefined) sessions.remove(sid)
        }
        // connect() calls transport.start() and takes ownership of the transport.
        // Cast to Transport: the SDK's StreamableHTTPServerTransport types `onclose`
        // as `(() => void) | undefined`, which trips the repo's exactOptionalPropertyTypes
        // against Transport's exact-optional `onclose?: () => void`. It nominally
        // implements Transport — the mismatch is purely the upstream `| undefined`.
        try {
          await opts.buildServer({ sub }).connect(transport as Transport)
          await transport.handleRequest(req, res, req.body)
        } catch (err) {
          // Init failed after the transport was created: close it so a half-open
          // session can't linger in the registry (when onsessioninitialized already
          // fired) or leak the connected McpServer/pool. onclose drops the map entry.
          // Swallow any close failure — sync throw OR async rejection — so it can
          // never mask the original init error.
          try {
            await transport.close()
          } catch {
            // ignore — the original init error below takes precedence
          }
          throw err
        }
      } finally {
        // Drop the in-flight reservation. On success the session is now committed in
        // the registry (via onsessioninitialized), so this only clears `pending`.
        reservation.release()
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
    // socket would otherwise leak its transport + McpServer until the idle sweeper
    // reaps it. Reclaim the session eagerly when this stream closes. Safe because no
    // `eventStore` is configured, so sessions are not resumable — a dropped stream
    // means the client must re-initialize anyway.
    res.on('close', () => {
      // Reclaim ONLY when this GET actually became the session's SSE stream (200).
      // A second/racing GET on a session that already owns a stream gets an SDK
      // error response (409 Conflict / 406 / …); that error response closing must
      // NOT tear down the still-live first stream and delete the session.
      if (res.statusCode !== 200) return
      // Fire-and-forget reclaim: swallow any close failure — an async rejection OR
      // a sync throw — so it can't become an unhandledRejection/uncaughtException
      // and crash the process (same hardening as the failed-init path above).
      try {
        void transport.close().catch(() => {})
      } catch {
        // ignore — best-effort reclaim of a dropped SSE stream
      }
    })
    await transport.handleRequest(req, res)
  })

  router.delete('/', async (req: Request, res: Response) => {
    const transport = resolveOwnedSession(req, res)
    if (transport === undefined) return
    await transport.handleRequest(req, res)
  })

  return { router, sessions }
}
