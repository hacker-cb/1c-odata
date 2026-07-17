---
"@1c-odata/mcp-server": minor
---

Add `@1c-odata/mcp-server`: a stateful Streamable HTTP MCP server that exposes the
read-only 1С:Enterprise OData V3 tools (`query`, `get_entity`, `count`,
`list_entities`, `describe_entity`, `list_enums`, `list_connections`,
`refresh_metadata`, `register_query`, `server_info`) over HTTP at `/mcp`, for
Claude custom connectors. Read-only surface — the connection-management tools are
intentionally excluded.

Three run modes, each opting into the next:

- **no-auth** — loopback only, over a `FileConnectionSource` from `--data-dir`.
- **OAuth 2.1** (`--public-url`) — an embedded better-auth authorization server with
  Dynamic Client Registration + PKCE; tokens are verified locally against JWKS.
- **multi-tenancy** (`--enc-key`) — bases live in Postgres with their 1С passwords
  encrypted at rest (AES-256-GCM, bound to the base name, key rotatable), per-user
  grants, and a server-rendered `/admin` panel whose first admin is bootstrapped
  through a one-time `/setup` token.

Programmatic entry point: `createHttpServer()` is **async** and resolves to a handle
— `{ server, close }` — where `server` is an unstarted `http.Server` you `listen()`
yourself and `close()` releases the auth store. Turnkey self-host (server + Postgres
+ Caddy auto-HTTPS) ships in `packages/mcp-server/deploy`.
