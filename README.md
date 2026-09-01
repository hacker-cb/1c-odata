# 1c-odata

[![CI](https://github.com/hacker-cb/1c-odata/actions/workflows/ci.yml/badge.svg)](https://github.com/hacker-cb/1c-odata/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@1c-odata/client)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@1c-odata/client)](./LICENSE)

TypeScript library for the standard OData interface of 1С:Enterprise 8 — OData protocol **version 3.0** (the dialect any modern 1С 8.3 base exposes; 1С does not offer an OData 4.0 interface). Ergonomic filter API, schema-driven date / Int64 / ValueStorage handling, and a single source of truth between schema and runtime. Codegen is the optional DX layer on top: generate types for full IDE completion, or [run against any base with zero generated files](#schema-sources).

> **Server-side only.** Built on server runtime APIs (`globalThis.fetch`, `Buffer`, `fs`), so it does not run in a browser. Minimum Node: **24.18.0** (active LTS). Pure ESM.
>
> ⚠️ **v0.x — pre-release.** API is unstable; see [`STABILITY.md`](./STABILITY.md).

## Packages

| Package | npm | Role |
|---|---|---|
| [`@1c-odata/client`](./packages/client) | [![npm](https://img.shields.io/npm/v/@1c-odata/client)](https://www.npmjs.com/package/@1c-odata/client) | Typed runtime — `ODataV3Client`, query builder, filter, value-storage, register helpers |
| [`@1c-odata/metadata`](./packages/metadata) | [![npm](https://img.shields.io/npm/v/@1c-odata/metadata)](https://www.npmjs.com/package/@1c-odata/metadata) | Run the client against any base at runtime — `createDynamicClient` / `fetchMetadataIndex`, no codegen; also the EDMX (`$metadata`) parser + `buildMetadataIndex` schema toolkit |
| [`@1c-odata/cli`](./packages/cli) | [![npm](https://img.shields.io/npm/v/@1c-odata/cli)](https://www.npmjs.com/package/@1c-odata/cli) | `1c-odata fetch` + `1c-odata generate` binaries; codegen lib at [`@1c-odata/cli/codegen`](./packages/cli/src/codegen) |
| [`@1c-odata/mcp`](./packages/mcp) | [![npm](https://img.shields.io/npm/v/@1c-odata/mcp)](https://www.npmjs.com/package/@1c-odata/mcp) | Local (stdio) MCP server for AI agents — read-only schema introspection + OData queries against any base via live `$metadata`, plus a connection-manager CLI. Built on `client` + `metadata` |

**AI agents:** `@1c-odata/mcp` (local, stdio) exposes read-only schema introspection + queries against any base — see its package README.

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
import { clientOptionsFromConnection, defineConnection, parseConnectionUrl } from '@1c-odata/client'
import { and, any } from '@1c-odata/client/filter'
import { createClient } from '../generated/trade/client.js'
import type { Document_РеализацияТоваровУслуг } from '../generated/trade/index.js'

// The runtime builds its own Connection (from env, DB, vault, …) — it does NOT
// import 1c-odata.config.ts, which exists only for the CLI.
const url = process.env.ONEC_URL
if (!url) throw new Error('Set ONEC_URL')
const conn = defineConnection({ ...parseConnectionUrl(url), serverTimezone: 'Europe/Moscow' })

// `createClient` is generated: it auto-loads the sibling `__metadata.json` and
// wires the `Functions` generic, so DateTime / Int64 / ValueStorage handling is on.
const trade = await createClient(clientOptionsFromConnection(conn))

const { value: docs } = await trade
  .query<Document_РеализацияТоваровУслуг>('Document_РеализацияТоваровУслуг')
  .filter((f) => and(f.Date.year().eq(2025), any(f.Товары, (t) => t.Сумма.gt(10000))))
  .top(50)
  .get()
```

See [`examples/basic`](./examples/basic) for a runnable end-to-end consumer.

## Schema sources

Every schema-driven runtime feature (DateTime / Int64 / ValueStorage handling, `validateOnWrite`) is powered by a `MetadataIndex`. The client doesn't care where it comes from — these are **peer sources, all producing identical runtime behavior**:

| Source | How | Compile-time types? |
|---|---|---|
| **Codegen** | `1c-odata generate` → the generated `createClient` auto-loads `__metadata.json` (the [Quick start](#quick-start) above) | ✅ full IDE completion |
| **Runtime fetch** | `createDynamicClient` / `fetchMetadataIndex` — download `$metadata` once, build the index | ❌ unless you pass a codegen `Functions` type |
| **Pinned cache** | `1c-odata generate --metadata-only` → `loadMetadataIndex`, or cache `fetchMetadataIndex` JSON → `parseMetadataIndex` | matches whichever produced it |
| **None (schema-less)** | just a URL + credentials | ❌ — `UntypedEntity` |

**The only difference between sources is compile-time types** — codegen adds them, the runtime path doesn't (unless handed a codegen `Functions` type). The schema-driven runtime behavior is the same code regardless of source. The runtime-fetch and schema-less modes below are both runnable in [`examples/dynamic`](./examples/dynamic).

### Runtime fetch: any base, zero generated files

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

Recipes: opt out of all date handling with `shape: { dateMode: 'string' }` and convert manually via `parseInZone` / `formatInZone`. With a runtime index (previous section) you can also introspect the base: `Object.keys(client.metadataIndex?.entitySetToType ?? {})` lists every entity set.

## Error handling

Every error the library throws extends `ODataError`. Catch broadly with `instanceof ODataError`, narrow with a subclass:

```ts
import { ODataError, HTTPError, BusinessError, ConcurrencyError, TimeoutError, ValidationError } from '@1c-odata/client'

try {
  await client.entity('Document_Заказ', key).patch({ Проведен: true }, { expectVersion })
} catch (e) {
  if (e instanceof ConcurrencyError) {
    // optimistic-concurrency guard tripped: DataVersion changed — refetch and retry
  } else if (e instanceof BusinessError) {
    console.error(`1С business rule: ${e.code} ${e.odata?.message}`) // HTTP 500, code "-1"
  } else if (e instanceof TimeoutError) {
    console.error(`timed out after ${e.timeoutMs}ms`)
  } else if (e instanceof HTTPError) {
    console.error(`HTTP ${e.status} ${e.statusText} (${e.errorFormat})`)
  } else if (e instanceof ValidationError) {
    console.error(e.issues) // only with validateOnWrite — thrown before any HTTP request
  } else if (e instanceof ODataError) {
    console.error(`${e.name}: ${e.message}`, e.request) // request is { method, url } — never headers
  }
}
```

Narrow before broad: `ConcurrencyError` / `BusinessError` / `PermissionError` extend `HTTPError`, so check them first. Caller-supplied `AbortSignal` aborts are rethrown unchanged (the native `AbortError`); library-issued timeouts surface as `TimeoutError`. The full hierarchy and field-level guarantees are in [`STABILITY.md`](./STABILITY.md#error-contract).

## Registers

`client.register(set)` is a typed facade over 1С register virtual tables — balances, turnovers, and slices. Turnover-style tables take a `{ from, to }` period **range** (mapped to `StartPeriod` / `EndPeriod`); `balance()` and slices take a single `Period` point. Every method accepts an optional trailing `ReadFiOptions` (`$top` + per-call `signal` / `timeout` / `retry`) and returns the rows directly (`Promise<R[]>`):

```ts
// AccumulationRegister — stock balance at a date, turnovers over a range
const balance = await client
  .register('AccumulationRegister_ТоварыНаСкладах')
  .balance({ Period: new Date('2025-01-01') }, { top: 100 })

const turnovers = await client
  .register('AccumulationRegister_ТоварыНаСкладах')
  .turnovers({ Period: { from: new Date('2025-01-01'), to: new Date('2025-12-31') } })

// InformationRegister — last slice at/before a date
const prices = await client
  .register('InformationRegister_ЦеныНоменклатуры')
  .sliceLast({ Period: new Date('2025-06-01') })

// AccountingRegister — debit/credit turnovers over a range
const drcr = await client
  .register('AccountingRegister_Хозрасчетный')
  .drCrTurnovers({ Period: { from: new Date('2025-01-01'), to: new Date('2025-03-31') } })
```

Also available: `balanceAndTurnovers`, `sliceFirst`, `extDimensions`, `recordsWithExtDimensions`, plus `recordsets()` / `records()` for the raw record sets — see [`packages/client/src/register.ts`](./packages/client/src/register.ts).

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

Requirements: Node 24.18+ (LTS Krypton), pnpm 10+.

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
