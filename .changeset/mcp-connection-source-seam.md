---
"@1c-odata/mcp": minor
---

Refactor `@1c-odata/mcp` for multi-tenant reuse (prep for a remote multi-tenant host).

- New `@1c-odata/mcp/internal` subpath exposing the reusable building blocks — `ConnectionPool`, the new `ConnectionSource`/`FileConnectionSource` seam, `ReadPool`, the read-only tool registrators (`registerSchemaTools`/`registerDataTools`/`registerServerInfoTool`), and the response-limit helpers. The connection-management tools stay off this surface (admin-only).
- `ConnectionPool` now takes a `ConnectionSource` (where connections and secrets come from) instead of `{ dataDir }`; the local stdio server injects a `FileConnectionSource` (config.json + keychain) and is unchanged. The read-only tool registrators now accept a `ReadPool`.
- The programmatic building blocks previously reachable from the `@1c-odata/mcp` root (`ConnectionPool`, `SecretStore`, `passwordEnvVar`, …) moved to `@1c-odata/mcp/internal`; the root now exposes only the local-server entry (`createMcpServer`, `runServe`) and config/data-dir helpers. No CLI, MCP-tool, or on-disk contract changed.
