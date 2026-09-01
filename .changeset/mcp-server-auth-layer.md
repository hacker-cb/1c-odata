---
"@1c-odata/mcp-server": minor
---

feat(mcp-server): OAuth 2.1 authorization on the HTTP MCP server

The Streamable HTTP MCP server can now require a Bearer JWT on `/mcp`. Enable it
by passing `--public-url <https-origin>` (or `ONEC_MCP_PUBLIC_URL`) to `serve`;
`BETTER_AUTH_SECRET` is then required.

- Embeds a better-auth authorization server (`jwt()` + `admin()` +
  `@better-auth/oauth-provider`) mounted at `/api/auth`, backed by a Postgres
  store — embedded PGlite for dev/tests, `pg` (via `--pg-url`/`DATABASE_URL`) for
  prod. better-auth's own tables only; no per-user base scoping yet.
- Dynamic Client Registration, `/sign-in` and `/consent` pages, RFC 8414 AS
  metadata and RFC 9728 Protected Resource Metadata
  (`/.well-known/oauth-protected-resource/mcp`) served CORS-open at the root.
- `/mcp` is gated by MCP's `requireBearerAuth`; access tokens are asymmetric JWTs
  whose `aud` is the MCP resource id (`${publicUrl}/mcp`), verified offline with
  `jose` against the AS's JWKS (issuer + audience pinned, JWT-only).

Without `--public-url` the server behaves exactly as before (no auth).

Internal: `createHttpServer` is now async and returns `{ server, close }`.
