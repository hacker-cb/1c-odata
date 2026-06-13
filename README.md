# 1c-odata

TypeScript library for the REST/OData interface of 1С:Enterprise 8 (V3 only — the only version 1С ships as of 2026). Ergonomic filter API, schema-driven date / Int64 / ValueStorage handling, and a single source of truth between schema and runtime. Codegen is the optional DX layer on top: generate types for full IDE completion, or [run against any base with zero generated files](#usage-without-codegen).

> **Server-side only.** Uses Node 22+ APIs (`globalThis.fetch`, `Buffer`, `fs`). Minimum Node: **22.21.0**. Pure ESM.
>
> ⚠️ **v0.x — pre-release.** API is unstable; see [`STABILITY.md`](./STABILITY.md).

## Packages

| Package | Role |
|---|---|
| [`@1c-odata/client`](./packages/client/src) | Typed runtime — `ODataV3Client`, query builder, filter, value-storage, register helpers |
| [`@1c-odata/metadata`](./packages/metadata/src) | Schema toolkit — parse `$metadata` (EDMX), build a runtime `MetadataIndex`, `createDynamicClient` for any base without codegen |
| [`@1c-odata/cli`](./packages/cli/src) | `1c-odata fetch` + `1c-odata generate` binaries; codegen lib at [`@1c-odata/cli/codegen`](./packages/cli/src/codegen) |

JSDoc on the public API is the canonical reference. Hover anything imported from `@1c-odata/client` in your IDE.

## Quick start

```bash
pnpm add @1c-odata/client
pnpm add -D @1c-odata/cli
```

`1c-odata.config.ts` — build-time config, read only by the `1c-odata` CLI:

```ts
import { parseConnectionUrl } from '@1c-odata/client'
import { defineCodegenConfig } from '@1c-odata/cli'

const url = process.env.ONEC_URL
if (!url) throw new Error('Set ONEC_URL (format: http://user:pwd@host/path)')

export default defineCodegenConfig({
  targets: {
    trade: {
      connection: {
        ...parseConnectionUrl(url),
        serverTimezone: 'Europe/Moscow', // REQUIRED IANA timezone; no default
      },
      include: ['Catalog_*', 'Document_*'],
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
import { clientOptionsFromConnection, defineConnection, ODataV3Client, parseConnectionUrl } from '@1c-odata/client'
import { and, any } from '@1c-odata/client/filter'
import type { Document_РТУ } from '../generated/trade/index.js'

// The runtime builds its own Connection (from env, DB, vault, …) — it does NOT
// import 1c-odata.config.ts, which exists only for the CLI.
const url = process.env.ONEC_URL
if (!url) throw new Error('Set ONEC_URL')
const trade = new ODataV3Client(
  clientOptionsFromConnection(
    defineConnection({ ...parseConnectionUrl(url), serverTimezone: 'Europe/Moscow' }),
  ),
)

const { value: docs } = await trade
  .query<Document_РТУ>('Document_РТУ')
  .filter((f) => and(f.Date.year().eq(2025), any(f.Товары, (t) => t.Сумма.gt(10000))))
  .top(50)
  .get()
```

See [`examples/basic`](./examples/basic) for a runnable end-to-end consumer.

## Usage without codegen

Codegen gives you TypeScript types — but every schema-driven runtime feature works from a `MetadataIndex` that can also be built **at runtime**. Two modes below, both runnable in [`examples/dynamic`](./examples/dynamic).

### Runtime metadata (recommended): any base, zero generated files

```bash
pnpm add @1c-odata/client @1c-odata/metadata
```

```ts
import { createDynamicClient } from '@1c-odata/metadata'

const client = await createDynamicClient(
  {
    baseUrl: 'http://1c.example.com/base/odata/standard.odata',
    auth: { username: 'user', password: 'pass' },
    serverTimezone: 'Europe/Moscow',
  },
  { validateOnWrite: true },
)

const { value } = await client.query('Catalog_Валюты').top(5).get()
```

`createDynamicClient` downloads `$metadata` (10+ MB on real bases, seconds), builds the index, and returns a ready `ODataV3Client` — full DateTime / Int64 / ValueStorage handling and write validation, exactly like the codegen path (same code builds `__metadata.json`). For multi-tenant servers cache the index instead of re-downloading:

```ts
import { ODataV3Client, clientOptionsFromConnection, parseMetadataIndex } from '@1c-odata/client'
import { fetchMetadataIndex } from '@1c-odata/metadata'

const cached = await cache.get(key)
const metadataIndex = cached ? parseMetadataIndex(JSON.parse(cached), key) : await fetchMetadataIndex(conn)
if (!cached) await cache.set(key, JSON.stringify(metadataIndex)) // ~1 MB JSON per base

const client = new ODataV3Client({ ...clientOptionsFromConnection(conn), metadataIndex })
```

Middle ground: `1c-odata generate --metadata-only` emits just `__metadata.json` (no TS files) — a pinned schema loaded via `loadMetadataIndex`, with no fetch at process startup.

### Fully schema-less: just a URL and credentials

```ts
import { BasicAuth, ODataV3Client, type UntypedEntity } from '@1c-odata/client'

const client = new ODataV3Client({
  baseUrl: 'http://1c.example.com/base/odata/standard.odata',
  auth: BasicAuth({ username: 'user', password: 'pass' }),
  serverTimezone: 'Europe/Moscow',
})

const { value } = await client.query<UntypedEntity>('Catalog_Номенклатура').top(10).get()
await client.entity('Document_Заказ', key).patch({ Дата: new Date() }) // → naive ISO in serverTimezone
```

Everything URL-shaped works without a schema: query builder + filter DSL, CRUD, registers, function imports, ValueStorage streams, retries/hooks. Dates are handled by value: reads recognize `Edm.DateTime` strings heuristically (sentinel → `null`), writes convert `Date` instances to naive ISO in `serverTimezone` and serialize `bigint` as the wire string. What you give up without a schema:

| Capability | With a `MetadataIndex` | Schema-less |
|---|---|---|
| IDE completion / field-name safety | with codegen types | `UntypedEntity` (open index signature) |
| `Edm.Int64` on read | `number` / `bigint` per `int64Mode` | stays a wire **string** |
| ValueStorage triples on read | grouped into `{ contentType, base64Data }` | flat `<X>_Base64Data` + `<X>_Type` fields |
| Clearing a date on write | `null` → sentinel automatically | pass `ONEC_EMPTY_DATE` explicitly (`null` stays `null`) |
| `validateOnWrite` | ✅ | ❌ (throws at construction) |

Recipes: opt out of all date handling with `shape: { dateMode: 'string' }` and convert manually via `parseInZone` / `formatInZone`. With a runtime index (previous section) you can also introspect the base: `Object.keys(client.metadataIndex.entitySetToType)` lists every entity set.

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
