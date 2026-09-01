---
"@1c-odata/mcp": patch
---

Prep `@1c-odata/mcp/internal` for a DB-backed multi-tenant host. Additive only — no CLI, MCP-tool, on-disk, or local stdio behavior changed.

- `SecretSource` gains a `'db'` variant so a DB-backed `ConnectionSource` can report the real password origin in `list_connections`. `SecretStore` itself never returns it (file/keychain/env only).
- `@1c-odata/mcp/internal` now re-exports `verifyConnectivity` — the standalone `$metadata` reachability probe (no `dataDir` dependency), reused by a remote host to verify a base before saving it. The connection-management functions (`upsertConnection`/`removeConnection`/`updateConnectionCredentials`/`setConnectionLabel`) stay private — they are bound to the file-backed config.
