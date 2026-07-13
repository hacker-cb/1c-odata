# Deploy: Docker Compose (self-host)

A single-command, self-contained production stack for `@1c-odata/mcp-server`:

- **mcp** — the server in multi-tenant mode (DB-backed bases, per-user grants, admin panel), built from this repo.
- **db** — Postgres for the auth/tenancy store. Schema migrations run automatically on boot.
- **caddy** — reverse proxy that terminates TLS with an **auto-provisioned, auto-renewed** certificate via ACME (Caddy's default CA is **Let's Encrypt**, with a ZeroSSL fallback) and forwards to the server.

> Single instance by design — session state, the `$metadata` cache and the health job are per-process. Run one stack; do not scale `mcp` to >1 replica.

## Prerequisites

- Docker + Docker Compose v2 on the host.
- A domain (`MCP_PUBLIC_DOMAIN`) with a DNS record pointing at the host, and inbound **80/443** open — Caddy needs both to solve the default ACME (HTTP-01) challenge and serve HTTPS. Serving an **internal-only host** (LAN/VPN clients, no public 80/443) or bringing **your own certificate**? See [TLS certificate options](#tls-certificate-options).

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

## TLS certificate options

Caddy terminates TLS; the app only ever speaks plain HTTP on the internal
network. How Caddy gets the certificate is up to you — three paths, pick by how
the host is reachable.

### Default — automatic HTTP-01 (public host)

The out-of-the-box behaviour described above: on the first HTTPS hit Caddy
provisions a Let's Encrypt certificate via the **HTTP-01** challenge and renews
it before expiry. Needs the domain to resolve to this host **and inbound 80/443
reachable from the internet** (80 carries the challenge). Nothing to configure —
this is what `.env.example` + the shipped `Caddyfile` do.

### Internal / grey-IP host — DNS-01

For a host on a private ("grey") IP — clients on the LAN or over VPN, nothing
exposed to the internet — HTTP-01 can't work (the CA can't reach port 80). The
**DNS-01** challenge proves domain ownership with a DNS `TXT` record instead, so
the host never needs to be publicly reachable. The CA validates purely through
the `TXT` record and **never queries your `A` record**, so the `A` record may
resolve to an RFC1918 address (`10.x` / `192.168.x`) and you still get a real,
publicly-trusted Let's Encrypt certificate — **nothing to install on any client**.

Requirements:

- The domain's zone is hosted at a DNS provider with an **API** (Cloudflare,
  Route53, DigitalOcean, …).
- The `_acme-challenge.<domain>` `TXT` record must resolve in the **public**
  authoritative DNS (that's what the CA reads). Because the CA never looks at the
  `A` record, you're free where it lives: publish it (pointing at the private IP)
  for simplicity, or keep it split-horizon / internal-only so the private IP is
  never exposed in public DNS.

The stock `caddy:2` image has no DNS-provider plugins, so build a small custom
image with [`xcaddy`](https://github.com/caddyserver/xcaddy) (Cloudflare shown;
swap in your provider's [`caddy-dns/*`](https://github.com/orgs/caddy-dns/repositories)
module):

```dockerfile
# Caddyfile.dns.Dockerfile — add it here in packages/mcp-server/deploy/
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare
FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
```

Point the `caddy` service at it (`build:` instead of `image: caddy:2`), tell
Caddy to use DNS-01 globally, and pass the provider token:

```caddyfile
# Caddyfile — add a global-options block above the site block
{
	acme_dns cloudflare {env.CF_API_TOKEN}
}

{$MCP_PUBLIC_DOMAIN} {
	reverse_proxy mcp:3000
}
```

Set `CF_API_TOKEN` in the `caddy` service's environment. With DNS-01 you no
longer need port **80** at all — only **443**, and only reachable from your
LAN/VPN clients.

> **Client reachability, not TLS, is the real constraint here.** An internal-only
> host works with MCP clients that run *inside* the network — **Claude Code** /
> **Claude Desktop** on a machine on the LAN or VPN make the `/mcp` calls
> themselves. The **hosted claude.ai** connector calls `/mcp` from Anthropic's
> servers over the public internet, so it can't reach a grey IP no matter the
> certificate — that path needs a publicly-exposed host.

### Bring your own / wildcard certificate — no ACME

If you already hold a certificate for the domain — e.g. a corporate wildcard
`*.example.com` — skip ACME entirely: mount the cert + key and point Caddy at
them. Works fully offline / air-gapped (no CA round-trip).

```caddyfile
# Caddyfile
{$MCP_PUBLIC_DOMAIN} {
	tls /etc/caddy/cert.pem /etc/caddy/key.pem
	reverse_proxy mcp:3000
}
```

Mount the files into the `caddy` service (read-only) and keep them current
yourself — Caddy won't renew a cert it didn't provision:

```yaml
# compose.yml — caddy service
volumes:
  - ./cert.pem:/etc/caddy/cert.pem:ro
  - ./key.pem:/etc/caddy/key.pem:ro
```

## Behind your own reverse proxy

The bundled Caddy is optional — front the server with **any** reverse proxy
(nginx, HAProxy, a corporate load balancer, a cloud ingress). The app only ever
speaks **plain HTTP** and never terminates TLS. Crucially, it does **not** trust
or read `X-Forwarded-*` headers and needs no `trust proxy` setting: it derives
its entire external identity — OAuth `iss`/`aud`, the Protected Resource
Metadata, the DNS-rebinding allowlist, and the `/admin` CSRF origin — from the
single `ONEC_MCP_PUBLIC_URL` you set. Spoofed forwarding headers therefore can't
shift its origin. To swap Caddy out, point your proxy at the `mcp` service (or
run the bin directly) on its HTTP port and drop the `caddy` service.

Your proxy must satisfy four things:

1. **Set `ONEC_MCP_PUBLIC_URL`** to the exact external HTTPS origin clients use
   (e.g. `https://1c-mcp.example.com`) — this is the connector URL and the OAuth
   issuer.
2. **Forward the original `Host`** — the DNS-rebinding guard auto-allows the
   `ONEC_MCP_PUBLIC_URL` host, so a proxy that preserves `Host` needs no extra
   config. If the proxy rewrites `Host` to an internal upstream name, set
   `ONEC_MCP_ALLOWED_HOSTS` to the raw `Host` value it actually sends
   (comma-separated for several).
3. **Don't buffer the response stream.** Streamable HTTP streams server→client
   over SSE on `GET /mcp`; a proxy that buffers responses or applies a short read
   timeout will stall or cut the stream. Disable response buffering and allow
   long-lived connections.
4. **Give it the origin root, not a sub-path.** OAuth discovery
   (`/.well-known/oauth-*`) and the app's routes (`/mcp`, `/api/auth/*`,
   `/sign-in`, `/consent`, `/admin`, `/setup`) are all origin-rooted, so serve it
   on its own hostname — mounting under a path prefix
   (`https://host/1c-mcp/…`) breaks Dynamic Client Registration and discovery.

Keep the **single-instance** rule (session state, the `$metadata` cache and the
health job are per-process) — the proxy fronts one upstream, not a pool.

An nginx server block covering all four:

```nginx
server {
    listen 443 ssl;
    server_name 1c-mcp.example.com;   # == ONEC_MCP_PUBLIC_URL host

    ssl_certificate     /etc/ssl/certs/1c-mcp.pem;
    ssl_certificate_key /etc/ssl/private/1c-mcp.key;

    location / {
        proxy_pass http://127.0.0.1:3000;   # the mcp bin's HTTP port
        proxy_set_header Host $host;         # preserve Host (req. 2)

        # SSE stream on GET /mcp — never buffer it, allow long connections (req. 3):
        proxy_buffering off;
        proxy_http_version 1.1;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

> `/admin` is served on the same origin (its CSRF check is bound to
> `ONEC_MCP_PUBLIC_URL`) and gated by the better-auth `admin` role. To narrow that
> surface, add an IP allow-list or extra auth in front of `location /admin` in
> your proxy.

## Operations

- **Update:** `git pull && docker compose up -d --build` (migrations re-run idempotently on boot).
- **Logs:** `docker compose logs -f mcp`.
- **Data:** lives in the `db-data` volume; TLS certs in `caddy-data`. Back both up. **Also back up `ONEC_MCP_ENC_KEY`** — without it the stored 1С passwords are unrecoverable.
- **Stop:** `docker compose down` (keeps volumes) — add `-v` to also drop the database and certs.

## Notes

- Only Caddy publishes host ports; Postgres and the direct `mcp:3000` port stay on the internal compose network. **`/admin` _is_ reachable** through Caddy at `https://$MCP_PUBLIC_DOMAIN/admin` — it has to be, since its CSRF check is bound to the public origin — but it is gated by the better-auth `admin` role (login + same-origin). To narrow that surface, add an IP allow-list or extra auth in front of `/admin` in the `Caddyfile`.
- Caddy preserves the original `Host` header, which the server's DNS-rebinding guard auto-allows from `ONEC_MCP_PUBLIC_URL` — no `ONEC_MCP_ALLOWED_HOSTS` needed. If you front this with a *different* proxy that rewrites `Host`, set `ONEC_MCP_ALLOWED_HOSTS` on the `mcp` service.
- **Local trial without a public domain:** set `MCP_PUBLIC_DOMAIN=localhost` and `MCP_PUBLIC_URL=https://localhost` — Caddy serves a local self-signed cert (your client must trust Caddy's local CA). Real connector use needs a real domain.
- **TLS is automatic** — on the first HTTPS request Caddy obtains a certificate from its default ACME CA (**Let's Encrypt**) and renews it before expiry; no certbot, cron, or manual step. It just needs the domain to resolve to this host and ports **80 + 443** open (80 for the ACME challenge). Keep the `caddy-data` volume — it holds the cert + ACME account, so wiping it forces re-issuance and can run into the CA's issuance rate limits. Optionally set an ACME email for expiry notices (see the `Caddyfile`). For an **internal host** that can't expose 80/443, or to use a certificate you already hold, see [TLS certificate options](#tls-certificate-options).

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
  `ONEC_MCP_ALLOWED_HOSTS` on the server to the public host. See
  [Behind your own reverse proxy](#behind-your-own-reverse-proxy) for the full
  proxy contract (Host, SSE buffering, origin root) and an nginx example.
- The three secrets kept out of the image and backed up (losing `ONEC_MCP_ENC_KEY`
  makes stored 1С passwords unrecoverable).

Concretely:

- **PaaS (Fly.io / Render / Railway):** point the platform at the prebuilt
  `ghcr.io/hacker-cb/1c-odata-mcp-server` image (or build the `Dockerfile`) and
  attach the platform's managed Postgres; TLS + the domain come from the platform,
  so you can drop the `caddy` service. Pin the app to a single machine/replica.
- **Bare VPS (systemd):** `npm i -g @1c-odata/mcp-server`, run `1c-odata-mcp-server
  serve --host 0.0.0.0 --port 3000` under a `systemd` unit, front it with your own
  TLS proxy (nginx/Caddy — see [Behind your own reverse proxy](#behind-your-own-reverse-proxy)),
  and point `DATABASE_URL` at a system Postgres.
- **Kubernetes:** a 1-replica `Deployment` + a Postgres (managed or in-cluster) +
  an Ingress with TLS. Single replica only until horizontal scaling lands.
