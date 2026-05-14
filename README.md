# 1c-odata

TypeScript library for the REST/OData interface of 1С:Enterprise 8 (V3 only — the only version 1С ships as of 2026). Codegen-driven type safety, ergonomic filter API, single source of truth between schema and runtime.

> **Server-side only.** Uses Node 22+ APIs (`globalThis.fetch`, `Buffer`, `fs`). Minimum Node: **22.21.0**. Pure ESM.
>
> ⚠️ **v0.x — pre-release.** API is unstable; see [`STABILITY.md`](./STABILITY.md).

## Packages

| Package | Role |
|---|---|
| [`@1c-odata/client`](./packages/client/src) | Typed runtime — `ODataV3Client`, query builder, filter, value-storage, register helpers |
| [`@1c-odata/cli`](./packages/cli/src) | `1c-odata fetch` + `1c-odata generate` binaries; codegen lib at [`@1c-odata/cli/codegen`](./packages/cli/src/codegen) |

JSDoc on the public API is the canonical reference. Hover anything imported from `@1c-odata/client` in your IDE.

## Quick start

```bash
pnpm add @1c-odata/client
pnpm add -D @1c-odata/cli
```

`1c-odata.config.ts`:

```ts
import { defineConfig, parseConnectionUrl } from '@1c-odata/client'

const url = process.env.ONEC_URL
if (!url) throw new Error('Set ONEC_URL (format: http://user:pwd@host/path)')

export default defineConfig({
  connections: {
    trade: {
      ...parseConnectionUrl(url),
      serverTimezone: 'Europe/Moscow', // REQUIRED IANA timezone; no default
      codegen: { include: ['Catalog_*', 'Document_*'] },
    },
  },
})
```

Fetch metadata and generate types:

```bash
export ONEC_URL=http://u:p@1c.example.com/odata/standard.odata
pnpm 1c-odata fetch
pnpm 1c-odata generate
```

Use the typed client:

```ts
import { clientOptionsFromConnection, ODataV3Client } from '@1c-odata/client'
import { and, any } from '@1c-odata/client/filter'
import type { Document_РТУ } from '../generated/trade/index.js'
import config from '../1c-odata.config.js'

const trade = new ODataV3Client(clientOptionsFromConnection(config.connections.trade!))

const { value: docs } = await trade
  .query<Document_РТУ>('Document_РТУ')
  .filter((f) => and(f.Date.year().eq(2025), any(f.Товары, (t) => t.Сумма.gt(10000))))
  .top(50)
  .get()
```

See [`examples/basic`](./examples/basic) for a runnable end-to-end consumer.

## Network configuration

TLS verification, HTTP proxy, and corporate CAs are configured **process-wide** via Node env vars / CLI flags, not per-client:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem
export HTTP_PROXY=http://user:pass@corp-proxy.example.com:8080
export HTTPS_PROXY=$HTTP_PROXY
export NO_PROXY=localhost,127.0.0.1
export NODE_USE_ENV_PROXY=1                  # or `node --use-env-proxy app.js`
export NODE_TLS_REJECT_UNAUTHORIZED=0        # DEV ONLY — never in production
```

For TLS-inspecting proxies (Zscaler, Netskope), combine `NODE_EXTRA_CA_CERTS` (the inspector's CA) with the proxy env vars. Per-tenant TLS/proxy and mTLS are not supported — run separate Node processes if you need different config per tenant.

## Cross-platform setup

Codegen output uses Cyrillic filenames (e.g. `documents/РеализацияТоваровУслуг.ts`). Once per project:

```text
# .gitattributes
* text=auto eol=lf
*.ts text working-tree-encoding=UTF-8
```

On macOS: `git config --global core.precomposeunicode true`. On Windows: `chcp 65001` for UTF-8 terminal output.

## Development

Requirements: Node 22.21+ (LTS Jod), pnpm 10+.

```bash
pnpm install
pnpm turbo build
pnpm turbo test:unit
pnpm turbo typecheck
pnpm biome ci .
```

Integration testing against live 1С bases — see [`snapshots/README.md`](./snapshots/README.md). Test layers (unit / offline integration / live / write) are gated independently by CI in [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

## Reference

- [`STABILITY.md`](./STABILITY.md) — semver policy, public API surface, error/connection/codegen contracts
- [`docs/1c/markdown/`](./docs/1c/markdown) — vendor documentation snapshot (Russian) for the 1С OData V3 dialect

## License

[MIT](./LICENSE)
