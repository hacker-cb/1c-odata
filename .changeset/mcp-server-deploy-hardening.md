---
"@1c-odata/mcp-server": patch
---

fix(mcp-server): deploy-stack hardening surfaced by CI smoke coverage

- Reject a malformed Postgres connection URI at boot (`createDb`): a
  `POSTGRES_PASSWORD` with a raw `/` (e.g. an `openssl rand -base64` value)
  corrupts `DATABASE_URL` — now fails loudly with a fix hint instead of an opaque
  pool error. Enforces what `deploy/.env.example` already documented.
- `compose.yml`: give the `mcp` service a `/healthz` healthcheck and make `caddy`
  wait for `service_healthy`, so first requests don't 502 during boot/migrations
  and a boot crash-loop is visible in `docker compose ps`.
- Drain idle keep-alive sockets on SIGTERM (`server.closeAllConnections()`) so
  shutdown completes within an orchestrator's grace window instead of waiting out
  each client.
