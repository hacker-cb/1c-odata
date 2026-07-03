---
"@1c-odata/mcp-server": minor
"@1c-odata/mcp": patch
---

feat(mcp-server): admin panel — role-gated server-rendered console (Slice 4)

Add an internal, `admin`-role-gated admin console to the multi-tenant HTTP
server (mounted at `/admin`, only on the DB-tenancy path). Server-rendered with
Express + Eta + a vendored, CSP-safe htmx (no CDN; `script-src 'self'`).

- **Dashboard** with a DB-aware `server_info` and a health table that polls the
  `health` table every 10 s.
- **Base CRUD** with verify-before-save: every create/edit runs
  `verifyConnectivity` first and persists nothing on failure; the 1С password is
  sealed write-only (AES-256-GCM via the keyring) and the process-global
  connection pool is `refresh()`-ed after each edit.
- **Grant editor** — user × base matrix backed by `GrantRepo` (adds
  `listByBase`); toggling a cell grants/revokes immediately.
- **User management** via the better-auth admin API (`createUser` / `setRole`).
- **Health job** — a single-instance `setInterval` that periodically probes each
  base with `verifyConnectivity` and records `ok`/`auth_failed`/`unreachable`;
  started/stopped with the server lifecycle.
- **`admin-create` CLI subcommand** — header-less first-admin bootstrap seed
  (better-auth ships no CLI for this).

The gate reads the better-auth browser session (`getSession` + `admin` role),
distinct from the Bearer/JWT machine path on `/mcp`.

`@1c-odata/mcp` (patch): re-export `assertValidConnectionName` /
`isValidConnectionName` from `/internal` so the admin write path enforces the
same ASCII connection-name rule as the file-backed store.
