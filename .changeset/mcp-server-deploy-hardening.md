---
"@1c-odata/mcp-server": patch
---

fix(mcp-server): deploy-stack hardening surfaced by CI smoke coverage

- `compose.yml`: give the `mcp` service a `/healthz` healthcheck and make `caddy`
  wait for `service_healthy`, so first requests don't 502 during boot/migrations
  and a boot crash-loop is visible in `docker compose ps`.
- Close idle keep-alive sockets on SIGTERM (`server.closeIdleConnections()`) so
  shutdown completes within an orchestrator's grace window; in-flight requests
  still drain normally.
