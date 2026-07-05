# @1c-odata/mcp-server

Streamable HTTP [MCP](https://modelcontextprotocol.io) server for
[`@1c-odata`](https://github.com/hacker-cb/1c-odata) — exposes the **read-only**
1С:Enterprise OData V3 tools (schema introspection + data queries) over HTTP so a
remote MCP client (e.g. a **Claude custom connector**) can reach a 1С base.

> Server-side only, pure ESM, Node ≥ 22.21. Part of the `@1c-odata` monorepo and
> released in lock-step with it.

The connection-management tools (`add` / `remove` / `set_credentials` /
`set_label`) are intentionally **not** exposed over MCP — this is a read-only
surface. The MCP endpoint is `POST/GET/DELETE /mcp` (stateful, per-session);
`GET /healthz` is a liveness probe.

## Running the CLI

`serve` and `admin-create` are subcommands of the `1c-odata-mcp-server` bin. How
you invoke it depends on context — pick one and read the examples below as the
command that follows:

- **Installed / published** — `npx @1c-odata/mcp-server serve …`, or after a
  global install simply `1c-odata-mcp-server serve …`. Runs the compiled `dist/`
  that the package ships; no TypeScript toolchain needed. The Docker image
  (`deploy/`) runs `dist/` too.
- **From a clone, production-like** — `pnpm -F @1c-odata/mcp-server start serve …`
  runs the built `dist/cli.js` (`pnpm install` builds it via the `prepare` hook).
- **From a clone, development** — `pnpm -F @1c-odata/mcp-server dev serve …` runs
  `src/cli.ts` through `tsx` — no build step, always the current source. Types
  aren't checked on the fly (run `pnpm -F @1c-odata/mcp-server typecheck`
  separately), and the workspace deps still need to be built once.

  (Append the CLI's args directly — no `--` separator, which pnpm would forward
  literally into the process.)

## Three run modes

The `serve` bin has three progressively-more-secure modes, selected by flags.

### 1. No auth — local / trusted network only

```bash
1c-odata-mcp-server serve --data-dir /path/to/data --port 3000
```

Reads bases + credentials from a local data dir (the same `config.json` +
credential store the `@1c-odata/mcp` CLI writes; `--data-dir` is optional and
resolves like that CLI — honors `ONEC_MCP_DATA_DIR`, defaults to the per-OS
config dir). **No authentication** — anyone who can reach `/mcp` can query every
configured base. Do **not** expose this mode publicly; keep it on loopback / a
trusted network, behind your own gateway.

### 2. OAuth — a Claude custom connector by URL

```bash
BETTER_AUTH_SECRET=... \
1c-odata-mcp-server serve --public-url https://mcp.example.com
```

Passing `--public-url` (or `ONEC_MCP_PUBLIC_URL`) mounts an embedded
[better-auth](https://better-auth.com) OAuth 2.1 authorization server (Dynamic
Client Registration + PKCE) alongside the resource server. A user adds the
connector to Claude with **just the URL** — Claude self-registers via DCR, the
user logs in on `/sign-in`, consents on `/consent`, and `/mcp` then requires a
valid JWT — verified locally against the AS's JWKS (no per-request introspection
call; the JWKS itself is fetched once and cached). `BETTER_AUTH_SECRET` is required.

Without a keyring (mode 3) this still uses the file data dir, so **every
authenticated user sees every base** — sign-up is closed, so users are
admin-provisioned. Reach for mode 3 for per-user isolation.

### 3. Multi-tenant — per-user bases + admin panel

```bash
BETTER_AUTH_SECRET=... ONEC_MCP_ENC_KEY="$(openssl rand -base64 32)" \
1c-odata-mcp-server serve \
  --public-url https://mcp.example.com \
  --pg-url postgres://user:pass@host/db   # else embedded PGlite (dev)
```

Adding `--enc-key` (or `ONEC_MCP_ENC_KEY`, a base64 32-byte AES-256 key) turns on
DB-backed multi-tenancy: bases live in the database, 1С passwords are encrypted
at rest (AES-256-GCM, bound to the base name), and each user sees only the bases
they are **granted**. Users are managed through an admin panel gated by the
better-auth `admin` role (server-rendered, internal-only) — CRUD of bases /
grants / users, connection health, all under `/admin`.

Bootstrap the first admin:

```bash
BETTER_AUTH_SECRET=... ONEC_MCP_ENC_KEY=... \
1c-odata-mcp-server admin-create --email admin@example.com --password '…' \
  --pg-url postgres://…            # a PERSISTENT store is required
```

The store is Postgres in production (`--pg-url` / `DATABASE_URL`) or embedded
PGlite for dev (`--auth-data-dir` to persist, else in-memory). Single instance:
session state, the `$metadata` cache, and the health job are per-process.

For a turnkey self-hosted stack (server + Postgres + Caddy auto-HTTPS) see
[`deploy/README.md`](./deploy/README.md) — `docker compose up` from `.env`.

## Programmatic

`createHttpServer` is **async** and returns a handle (the server is unstarted —
call `.listen(...)`; `close()` also tears down the auth store):

```ts
import { createHttpServer } from '@1c-odata/mcp-server'
import { FileConnectionSource } from '@1c-odata/mcp/internal'

const source = new FileConnectionSource({ dataDir: '/path/to/data' })
// No-auth: omit `auth`. Add `auth: { publicUrl, dialect, secret, keyring? }`
// for OAuth (+ a keyring for multi-tenancy).
const { server, close } = await createHttpServer({ source, dataDir: '/path/to/data' })
server.listen(3000)
// On shutdown, stop accepting connections FIRST, then drain the auth store —
// `server.close` is callback-based, so wait for it before calling `close()`:
//   server.close(() => { void close() })
```

## Hardening

- **DNS-rebinding protection** (via `serve`): the transport validates the `Host`
  header against an allowlist. It is derived from the bound address (`host:port` +
  `localhost`/`127.0.0.1`) plus — when `--public-url` is set — the public origin's
  `Host`, so a reverse proxy that forwards the original `Host` needs no extra
  config. Only when the proxy presents a *different* `Host` set
  `ONEC_MCP_ALLOWED_HOSTS` — comma-separated raw `Host` values (`host` with the
  default port omitted, as clients send it, or `host:port`), respected verbatim as
  an override.
- Sessions are pinned to the authenticated principal (`sub`): a request whose
  token belongs to a different user is rejected. 1С passwords are write-only in
  the admin UI and never returned in any response.
- The public surface is `/mcp`, `/.well-known/*`, `/api/auth/*`, `/sign-in`,
  `/consent`; keep `/admin` and the database internal.
