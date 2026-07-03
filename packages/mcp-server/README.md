# @1c-odata/mcp-server

Streamable HTTP [MCP](https://modelcontextprotocol.io) server for
[`@1c-odata`](https://github.com/hacker-cb/1c-odata) — exposes the **read-only**
1С:Enterprise OData V3 tools (schema introspection + data queries) over HTTP so a
remote MCP client (e.g. a Claude custom connector) can reach a 1С base.

> Server-side only, pure ESM, Node ≥ 22.21. Part of the `@1c-odata` monorepo and
> released in lock-step with it.

## Usage

```bash
# Serve the read-only tools over Streamable HTTP, backed by a local data dir
# (config.json + credentials) — the same store the `@1c-odata/mcp` CLI writes.
1c-odata-mcp-server serve --data-dir /path/to/data --port 3000
```

`--data-dir` is optional: like the `1c-odata-mcp` CLI it resolves through the same
rules (honors `ONEC_MCP_DATA_DIR`, defaults to the per-OS config dir), so a
connection added once with the CLI is visible to the server.

Programmatic:

```ts
import { createHttpServer } from '@1c-odata/mcp-server'
import { FileConnectionSource } from '@1c-odata/mcp/internal'

const source = new FileConnectionSource({ dataDir: '/path/to/data' })
const server = createHttpServer({ source, dataDir: '/path/to/data' })
server.listen(3000)
```

The MCP endpoint is `POST/GET/DELETE /mcp` (stateful, per-session); `GET /healthz`
is a liveness probe. **No authentication in this build** — the OAuth layer and
multi-tenancy land in later slices. Do not expose it publicly without a gateway.

**DNS-rebinding protection** is on by default when run via the `serve` bin: the
transport validates the `Host` header against an allowlist derived from the bound
address (`host:port` + `localhost`/`127.0.0.1`). Behind a reverse proxy whose
public host differs, set `ONEC_MCP_ALLOWED_HOSTS` (comma-separated `host:port`).
The programmatic `createHttpServer({ allowedHosts })` leaves it off unless you pass
an allowlist.

The connection-management tools (`add` / `remove` / `set_credentials` /
`set_label`) are intentionally **not** exposed — this is a read-only surface.
