# Deploy: Docker Compose (self-host)

A single-command, self-contained production stack for `@1c-odata/mcp-server`:

- **mcp** — the server in multi-tenant mode (DB-backed bases, per-user grants, admin panel), built from this repo.
- **db** — Postgres for the auth/tenancy store. Schema migrations run automatically on boot.
- **caddy** — reverse proxy that terminates TLS with an **auto-provisioned** certificate and forwards to the server.

> Single instance by design — session state, the `$metadata` cache and the health job are per-process. Run one stack; do not scale `mcp` to >1 replica.

## Prerequisites

- Docker + Docker Compose v2 on the host.
- A domain (`MCP_PUBLIC_DOMAIN`) with a DNS record pointing at the host, and inbound **80/443** open — Caddy needs both to solve the ACME challenge and serve HTTPS.

## 1. Configure

From this directory (`packages/mcp-server/deploy/`):

```bash
cp .env.example .env
# then edit .env — set the domain and generate the three secrets:
#   BETTER_AUTH_SECRET=$(openssl rand -base64 32)
#   ONEC_MCP_ENC_KEY=$(openssl rand -base64 32)
#   POSTGRES_PASSWORD=$(openssl rand -base64 24)
```

`MCP_PUBLIC_URL` is the origin you'll add to Claude — normally `https://${MCP_PUBLIC_DOMAIN}`.

## 2. Start

```bash
docker compose up -d --build
```

First run builds the image (installs the workspace, builds, emits a self-contained tree) and boots Postgres → mcp → Caddy. Caddy issues the TLS cert on first HTTPS hit.

Check health:

```bash
docker compose ps
curl -fsS https://$MCP_PUBLIC_DOMAIN/healthz && echo OK   # liveness probe
```

## 3. Bootstrap the first admin

Sign-up is closed, so seed one admin directly in the store (reuses the `mcp` service env):

```bash
docker compose run --rm mcp admin-create \
  --email you@example.com --password 'a-strong-password'
```

Then open `https://$MCP_PUBLIC_DOMAIN/admin`, sign in, and add your 1С bases + user grants.

## 4. Connect Claude

Add a **custom connector** in Claude with the URL `MCP_PUBLIC_URL` (e.g. `https://mcp.example.com`). Claude self-registers (DCR), you log in on `/sign-in`, consent, and its queries then hit `/mcp` with a verified token — scoped to the bases you granted that user.

## Operations

- **Update:** `git pull && docker compose up -d --build` (migrations re-run idempotently on boot).
- **Logs:** `docker compose logs -f mcp`.
- **Data:** lives in the `db-data` volume; TLS certs in `caddy-data`. Back both up. **Also back up `ONEC_MCP_ENC_KEY`** — without it the stored 1С passwords are unrecoverable.
- **Stop:** `docker compose down` (keeps volumes) — add `-v` to also drop the database and certs.

## Notes

- The `mcp` service publishes no host ports — only Caddy is exposed. The internal surface (`/admin`, Postgres) never leaves the compose network.
- Caddy preserves the original `Host` header, which the server's DNS-rebinding guard auto-allows from `ONEC_MCP_PUBLIC_URL` — no `ONEC_MCP_ALLOWED_HOSTS` needed. If you front this with a *different* proxy that rewrites `Host`, set `ONEC_MCP_ALLOWED_HOSTS` on the `mcp` service.
- **Local trial without a public domain:** set `MCP_PUBLIC_DOMAIN=localhost` and `MCP_PUBLIC_URL=https://localhost` — Caddy serves a local self-signed cert (your client must trust Caddy's local CA). Real connector use needs a real domain.
