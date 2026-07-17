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

`serve`, `admin-create`, and `set-password` are subcommands of the
`1c-odata-mcp-server` bin. How you invoke it depends on context — pick one and read
the examples below as the command that follows:

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

**Rotating the encryption key.** Every sealed secret records the id of the key that
sealed it, so old and new keys can coexist: `ONEC_MCP_ENC_KEY` is always the key new
secrets are sealed with, and `ONEC_MCP_ENC_KEYS_PREVIOUS` holds retired keys for
decryption only.

```bash
# Before:  ONEC_MCP_ENC_KEY=<key1>   ONEC_MCP_ENC_KEY_ID=1
ONEC_MCP_ENC_KEY="$(openssl rand -base64 32)"   # the new key…
ONEC_MCP_ENC_KEY_ID=2                           # …under a NEW id
ONEC_MCP_ENC_KEYS_PREVIOUS=1:<key1>             # the old one, decrypt-only
```

Re-sealing is **lazy**: a base's secret moves to the new key when its password is
next saved in `/admin`. Keep the retired key in `ONEC_MCP_ENC_KEYS_PREVIOUS` until
every base has been re-saved — dropping it earlier leaves those secrets unreadable.
A malformed key, a duplicate id, or a key that is not 32 bytes fails the boot loudly
rather than stranding data.

**Bootstrap the first admin — the setup wizard.** On boot, while no admin exists,
the server prints a one-time `…/setup?token=…` URL to its log (at `warn` level,
re-printed on every restart until an admin is created). Open it in a browser to
create the first admin. The wizard is reachable **only** while no admin exists
**and** the token matches; it 404s forever once the first admin is created, and
the token is single-use. `/sign-in` shows a "first-run setup pending" hint (the
token is only ever in the log, never in a page).

Break-glass alternatives, both requiring a PERSISTENT store:

```bash
# Non-interactive first-admin seed (equivalent to the wizard, for automation).
# Both commands build the auth store, so they need the same public URL + secret
# `serve` uses (or pass --public-url instead of the env var):
BETTER_AUTH_SECRET=... ONEC_MCP_PUBLIC_URL=https://mcp.example.com \
1c-odata-mcp-server admin-create --email admin@example.com --password '…' \
  --pg-url postgres://…

# Reset a forgotten password for an existing user:
BETTER_AUTH_SECRET=... ONEC_MCP_PUBLIC_URL=https://mcp.example.com \
1c-odata-mcp-server set-password --email admin@example.com --password '…' \
  --pg-url postgres://…
```

The store is Postgres in production (`--pg-url` / `DATABASE_URL`) or embedded
PGlite for dev (`--auth-data-dir` to persist, else in-memory). Single instance:
session state, the `$metadata` cache, and the health job are per-process.

**Connection health.** The dashboard shows each base's reachability, kept current by
a background job that probes every base on an interval, plus a **Check connections
now** button for an on-demand sweep (with a per-base "checking" spinner). The probe
is a lightweight `GET` on the OData service root — *not* a full `$metadata` download
(~20× less data on real bases), so it's cheap on the 1С server and safe under a short
timeout. Both knobs are tunable via process-wide env:

| Env var | Default | Meaning |
|---|---|---|
| `ONEC_MCP_HEALTH_INTERVAL_MS` | `60000` | Background probe interval (ms). |
| `ONEC_MCP_HEALTH_TIMEOUT_MS` | `5000` | Per-base probe timeout (ms). |

**Session limits.** Each MCP client `initialize` opens a live session (its own
`McpServer` + transport, dispatched by the `Mcp-Session-Id` header). Two guards keep
one tenant from exhausting the process and reclaim abandoned sessions:

- a **per-principal quota** so a single `sub` can't occupy every global slot and 503
  everyone else (the no-auth loopback principal is exempt — one trusted owner), and
- an **idle sweeper** that reaps sessions **with no open SSE stream** left untouched
  beyond a TTL — reclaiming POST-only sessions that never send `DELETE`. A client
  holding a live GET stream is a connected client and is exempt (its socket is
  reclaimed when the stream closes). A client whose session was swept (or that
  reconnects after a long pause) transparently re-initializes — the server returns
  `404` for the stale id, the spec's "start a new session" signal (safe because
  sessions aren't resumable).

| Env var | Default | Meaning |
|---|---|---|
| `ONEC_MCP_MAX_SESSIONS` | `1024` | Global concurrent-session ceiling (all principals). |
| `ONEC_MCP_MAX_SESSIONS_PER_SUB` | `32` | Per-principal concurrent-session quota. |
| `ONEC_MCP_SESSION_IDLE_MS` | `1800000` | Reap a session after this much inactivity (30 min). |
| `ONEC_MCP_SESSION_SWEEP_MS` | `60000` | Idle-sweeper period (ms). |

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
  `/consent`, and the token-gated `/setup` (first-run only); keep `/admin` and the
  database internal.
