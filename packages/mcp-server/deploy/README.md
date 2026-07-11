# Deploy: Docker Compose (self-host)

A single-command, self-contained production stack for `@1c-odata/mcp-server`:

- **mcp** — the server in multi-tenant mode (DB-backed bases, per-user grants, admin panel), built from this repo.
- **db** — Postgres for the auth/tenancy store. Schema migrations run automatically on boot.
- **caddy** — reverse proxy that terminates TLS with an **auto-provisioned, auto-renewed** certificate via ACME (Caddy's default CA is **Let's Encrypt**, with a ZeroSSL fallback) and forwards to the server.

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
#   POSTGRES_PASSWORD=$(openssl rand -hex 24)     # hex — URL-safe for DATABASE_URL
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

### Run from the published image (no build)

Each release publishes a multi-arch (`amd64` + `arm64`) image to GHCR:
`ghcr.io/hacker-cb/1c-odata-mcp-server`, tagged `X.Y.Z` (exact), `X.Y` (latest
patch), and `latest`. The `compose.prod.yml` overlay swaps the source build for a
pull, so a host needs only `compose.yml`, `compose.prod.yml`, `Caddyfile`, and
`.env` — no monorepo checkout, no build toolchain:

```bash
export MCP_IMAGE_TAG=0.7.0                                   # pin an exact version
docker compose -f compose.yml -f compose.prod.yml pull
docker compose -f compose.yml -f compose.prod.yml up -d
```

Updating is then just `MCP_IMAGE_TAG=<new> docker compose -f compose.yml -f compose.prod.yml pull && … up -d` — migrations re-run idempotently on boot.

## 3. Bootstrap the first admin

Sign-up is closed, so the server seeds the first admin through a **one-time setup
wizard** gated by a token it prints to its own log at boot (and re-prints on every
restart until an admin exists). No crafted console command is needed.

After `docker compose up`, find the printed URL:

```bash
docker compose logs mcp | grep 'FIRST-RUN SETUP'
# → …/setup?token=<one-time-token>
```

Open that `https://$MCP_PUBLIC_DOMAIN/setup?token=…` URL in a browser and create
the first admin (email + password). The wizard is reachable **only** while no
admin exists **and** the token matches; it 404s the instant the first admin is
created, and the token is single-use. Then sign in at
`https://$MCP_PUBLIC_DOMAIN/sign-in` and add your 1С bases + user grants under
`/admin`.

> **Treat the printed URL as a secret** — it carries the one-time token (and so
> can leak via browser history, `Referer`, or a proxy log). Don't paste it into
> shared tools; open it directly. It self-closes once the first admin is created.

**Alternatives (break-glass):**

```bash
# Non-interactive seed (equivalent to the wizard, for automation):
docker compose run --rm mcp admin-create \
  --email you@example.com --password 'a-strong-password'

# Forgotten password — reset an existing user's password directly in the store:
docker compose run --rm mcp set-password \
  --email you@example.com --password 'a-new-strong-password'
```

## 4. Connect Claude

Add a **custom connector** in Claude with the URL `MCP_PUBLIC_URL` (e.g. `https://mcp.example.com`). Claude self-registers (DCR), you log in on `/sign-in`, consent, and its queries then hit `/mcp` with a verified token — scoped to the bases you granted that user.

## Operations

- **Update:** `git pull && docker compose up -d --build` (migrations re-run idempotently on boot).
- **Logs:** `docker compose logs -f mcp`.
- **Data:** lives in the `db-data` volume; TLS certs in `caddy-data`. Back both up. **Also back up `ONEC_MCP_ENC_KEY`** — without it the stored 1С passwords are unrecoverable.
- **Stop:** `docker compose down` (keeps volumes) — add `-v` to also drop the database and certs.

## Notes

- Only Caddy publishes host ports; Postgres and the direct `mcp:3000` port stay on the internal compose network. **`/admin` _is_ reachable** through Caddy at `https://$MCP_PUBLIC_DOMAIN/admin` — it has to be, since its CSRF check is bound to the public origin — but it is gated by the better-auth `admin` role (login + same-origin). To narrow that surface, add an IP allow-list or extra auth in front of `/admin` in the `Caddyfile`.
- Caddy preserves the original `Host` header, which the server's DNS-rebinding guard auto-allows from `ONEC_MCP_PUBLIC_URL` — no `ONEC_MCP_ALLOWED_HOSTS` needed. If you front this with a *different* proxy that rewrites `Host`, set `ONEC_MCP_ALLOWED_HOSTS` on the `mcp` service.
- **Local trial without a public domain:** set `MCP_PUBLIC_DOMAIN=localhost` and `MCP_PUBLIC_URL=https://localhost` — Caddy serves a local self-signed cert (your client must trust Caddy's local CA). Real connector use needs a real domain.
- **TLS is automatic** — on the first HTTPS request Caddy obtains a certificate from its default ACME CA (**Let's Encrypt**) and renews it before expiry; no certbot, cron, or manual step. It just needs the domain to resolve to this host and ports **80 + 443** open (80 for the ACME challenge). Keep the `caddy-data` volume — it holds the cert + ACME account, so wiping it forces re-issuance and can run into the CA's issuance rate limits. Optionally set an ACME email for expiry notices (see the `Caddyfile`).

## Other deployment targets

Docker Compose (above) is the reference, but nothing here is Compose-specific — the
same binary — the published npm package, or an image you build from the
`Dockerfile` — runs on **any Node host or container platform** with the SAME env
contract: `BETTER_AUTH_SECRET`, `ONEC_MCP_ENC_KEY`, `DATABASE_URL`,
`ONEC_MCP_PUBLIC_URL` (see the package [README](../README.md#running-the-cli) for
invocation and the auth modes). Whatever you pick, a deploy must satisfy:

- **One instance** — session state, the `$metadata` cache and the health job are
  per-process; do not run more than one replica.
- **A persistent Postgres** (`DATABASE_URL`); migrations run on boot.
- **TLS terminated by a proxy that forwards the original `Host`** — else set
  `ONEC_MCP_ALLOWED_HOSTS` on the server to the public host.
- The three secrets kept out of the image and backed up (losing `ONEC_MCP_ENC_KEY`
  makes stored 1С passwords unrecoverable).

Concretely:

- **PaaS (Fly.io / Render / Railway):** point the platform at the prebuilt
  `ghcr.io/hacker-cb/1c-odata-mcp-server` image (or build the `Dockerfile`) and
  attach the platform's managed Postgres; TLS + the domain come from the platform,
  so you can drop the `caddy` service. Pin the app to a single machine/replica.
- **Bare VPS (systemd):** `npm i -g @1c-odata/mcp-server`, run `1c-odata-mcp-server
  serve --host 0.0.0.0 --port 3000` under a `systemd` unit, front it with your own
  TLS proxy (nginx/Caddy), and point `DATABASE_URL` at a system Postgres.
- **Kubernetes:** a 1-replica `Deployment` + a Postgres (managed or in-cluster) +
  an Ingress with TLS. Single replica only until horizontal scaling lands.
