# @1c-odata/client

## 0.4.0

### Minor Changes

- [#29](https://github.com/hacker-cb/1c-odata/pull/29) [`27c207a`](https://github.com/hacker-cb/1c-odata/commit/27c207a770b6969872db5f07b7a334574313a12a) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Error-handling architecture: honest `HTTPError` envelope model, request context on every error, and a dedicated `MetadataError`.

  - `ODataError` now carries `request?: { method, url }`, populated on every request-originated error (`HTTPError`, `NetworkError`, `TimeoutError`) so a caught error knows which call produced it. It excludes headers by design — the `Authorization` header never lands in logs. Errors not tied to a request (`InvalidArgumentError`, `ValidationError`, `MetadataError`) omit it.
  - `HTTPError` no longer fabricates an OData body when the server didn't send one. `ErrorFormat` gains `'none'`; the parsed-envelope field is renamed `body` → `odata` and is now optional, as is `code` (both present only with a real JSON/XML `odata.error`); a new `rawBody` carries a truncated (≤512 char) snippet of the raw response. A non-2xx with no recognizable envelope (wrong entity-set path, missing base, over-long URL, HTML/proxy error page) now throws a real `HTTPError` with the status preserved and an actionable message — previously this surfaced as a `ParseError` that dropped the status code.
  - New `MetadataError` (extends `ODataError`) for schema-metadata failures: `loadMetadataIndex` / `parseMetadataIndex` and `parseEdmx` now throw it instead of `ParseError`. `ParseError` is reserved for HTTP response-body parse failures. `@1c-odata/metadata` re-exports `MetadataError` and `ODataError` so consumers can catch without a separate `@1c-odata/client` import.
  - `ConcurrencyError` from the client-side `expectVersion` guard no longer fabricates `errorFormat:'json'`/`body`/`code` — it reports `errorFormat:'none'` (no server response exists) while keeping `status: 412` and subclass identity.

  **Breaking (v0.x):**

  - `HTTPError.body` is renamed to `HTTPError.odata` and is now `ODataErrorBody | undefined`; `HTTPError.code` is now `string | undefined`. Guard before dereferencing (e.g. `err.odata?.message`).
  - A 401/412 _without_ an OData envelope now arrives as a generic `HTTPError` (with `status === 401`/`412`), not `PermissionError`/`ConcurrencyError`.
  - `loadMetadataIndex` / `parseMetadataIndex` / `parseEdmx` now throw `MetadataError` instead of `ParseError`. Catch `MetadataError` for local metadata/EDMX failures, or `ODataError` to cover both domains.

  `instanceof` identity, `HTTPError.status` (always present), and `Error.message` mutability are unchanged.

- [#27](https://github.com/hacker-cb/1c-odata/pull/27) [`f065038`](https://github.com/hacker-cb/1c-odata/commit/f0650388106795f5754d2f77574cfee8d45f50f9) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Fix the AccountingRegister `RegisterHelper` virtual-table methods, and add `$top` + per-call request options to every register FI.

  Extending live coverage to the full register surface (verified against УТ 11.5 + БП 3.0) surfaced that several `RegisterHelper` methods sent parameters 1С rejects — the same class of bug as the AccumulationRegister turnovers fix. MSW unit tests missed them because they only echo the URL the client builds:

  - **`drCrTurnovers()`** sent `StartDate`/`EndDate` (HTTP 501 live) and modelled non-existent `@odata.bind` `AccountDr`/`AccountCr` params. It now sends `StartPeriod`/`EndPeriod` via a `Period: { from?, to? }` range and exposes the real string filters (`AccountCondition`, `BalancedAccountCondition`, `Condition`, `Dimensions`, `ExtraDimensions`, `BalancedExtraDimensions`).
  - **`recordsWithExtDimensions()`** sent `StartDate`/`EndDate` (HTTP 501 live). Now `Period: { from?, to? }` → `StartPeriod`/`EndPeriod`, plus optional `Condition` / `Order` / `Top`.
  - **`extDimensions()`** sent a fabricated `Account_Key` parameter (the FI takes none). It now takes no FI arguments.
  - AccountingRegister `balance()` / `turnovers()` / `balanceAndTurnovers()` work too (these virtual tables exist on AccountingRegisters). `BalanceArgs` / `TurnoversArgs` gain the AccountingRegister-only `AccountCondition` / `ExtraDimensions` filters, and the shared methods now forward every supplied arg by presence — so account filters are no longer silently dropped on the shared FIs.

  All register FI methods now accept an optional trailing `ReadFiOptions` (`{ top? }` plus the per-call `signal` / `timeout` / `retry` from `RequestOptions`) → `$top`, so the large collections big registers return (e.g. a full AccountingRegister `Balance`) can be bounded or aborted instead of fetched whole.

  **Breaking (types):**

  - `DrCrTurnoversArgs` reworked: `{ StartDate, EndDate, AccountDr, AccountCr }` → `{ Period: { from?, to? }, Condition?, AccountCondition?, BalancedAccountCondition?, Dimensions?, ExtraDimensions?, BalancedExtraDimensions? }`.
  - `RecordsWithExtDimensionsArgs` reworked: `{ StartDate, EndDate }` → `{ Period: { from?, to? }, Condition?, Order?, Top? }`.
  - `ExtDimensionsArgs` removed; `extDimensions()` takes no arguments.

  InformationRegister `sliceFirst()` / `sliceLast()` are unchanged — they correctly invoke the FI on the registered set (the common case). The doc now notes the minority of registers whose slice binds to `_RecordType`: register the `_RecordType` set for those.

- [#19](https://github.com/hacker-cb/1c-odata/pull/19) [`968a14e`](https://github.com/hacker-cb/1c-odata/commit/968a14e3c52e70026a1c4eae5336d63c0ca386b3) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Split the runtime connection descriptor from the build-time codegen config.

  The single `defineConfig` / `CliConfig` object mixed three lifecycles in one file the app runtime had to import: the runtime connection (`baseUrl`/`auth`/`serverTimezone`/`shape`), build-only codegen settings (`include`, `fetchTimeout`, `metadataDir`, `generatedDir`), and secrets. They are now cleanly separated:

  - **`@1c-odata/client`** owns the runtime `Connection` — now just `baseUrl`, `auth`, `serverTimezone`, `shape` — plus a new `defineConnection` helper. `CliConfig` and `defineConfig` are **removed** from this package (the zero-dep runtime core no longer carries build-tool concepts).
  - **`@1c-odata/cli`** owns the build-time codegen config: new `defineCodegenConfig` + `CodegenConfig` / `CodegenTarget` types. A target wraps a `connection` plus codegen options.
  - The app runtime no longer imports `1c-odata.config.ts` — it builds its `Connection` directly (from env, a database, a vault, …), so build settings and secrets stay out of the runtime graph.

  **Migration — `1c-odata.config.ts`:**

  ```diff
  -import { defineConfig, parseConnectionUrl } from '@1c-odata/client'
  +import { parseConnectionUrl } from '@1c-odata/client'
  +import { defineCodegenConfig } from '@1c-odata/cli'

  -export default defineConfig({
  -  connections: {
  -    trade: {
  -      ...parseConnectionUrl(url),
  -      serverTimezone: 'Europe/Moscow',
  -      codegen: { include: ['Catalog_*'] },
  -    },
  -  },
  -})
  +export default defineCodegenConfig({
  +  targets: {
  +    trade: {
  +      connection: { ...parseConnectionUrl(url), serverTimezone: 'Europe/Moscow' },
  +      include: ['Catalog_*'],
  +    },
  +  },
  +})
  ```

  **Migration — runtime** (build the `Connection`, don't import the config file):

  ```diff
  -import config from '../1c-odata.config.js'
  -const client = new ODataV3Client(clientOptionsFromConnection(config.connections.trade!))
  +import { defineConnection, parseConnectionUrl } from '@1c-odata/client'
  +const conn = defineConnection({ ...parseConnectionUrl(process.env.ONEC_URL!), serverTimezone: 'Europe/Moscow' })
  +const client = new ODataV3Client(clientOptionsFromConnection(conn))
  ```

  Other breaking changes:

  - CLI selection flag renamed `--connection` → `--target` (e.g. `1c-odata fetch --target trade`).
  - `Connection.fetchTimeout` removed — set the `$metadata` download timeout per codegen target (`CodegenTarget.fetchTimeout`), at config level (`CodegenConfig.fetchTimeout`), or per call (`fetchMetadataIndex(conn, { timeout })`).
  - `Connection.codegen` removed — the `include` whitelist now lives directly on the codegen target.

- [#26](https://github.com/hacker-cb/1c-odata/pull/26) [`b1507e8`](https://github.com/hacker-cb/1c-odata/commit/b1507e8c98bba793527cfdb8a07059b06628f983) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Fix `RegisterHelper.turnovers()` / `balanceAndTurnovers()` sending the wrong period parameters to 1С.

  Both helpers previously flattened a date range to `StartDate`/`EndDate`. The 1С AccumulationRegister `Turnovers` / `BalanceAndTurnovers` virtual tables only accept `StartPeriod`/`EndPeriod`, so every range query was rejected with HTTP 501 («Параметр EndDate не поддерживается»). They now send `StartPeriod`/`EndPeriod`. Verified live against УТ 11.1, УТ 11.5 and БП 3.0: the new params return 200, the old ones 501. (`StartDate`/`EndDate` belong to the AccountingRegister `drCrTurnovers()` / `recordsWithExtDimensions()` tables and are intentionally left untouched.)

  **Breaking (type):** `TurnoversArgs.Period` is now an interval `{ from?: Date; to?: Date }` and no longer accepts a bare `Date`. Turnovers have no single-point form in 1С — there is no `Period` parameter on these tables, and a point query returned 501. The type forbids a bare `Date`; an untyped (JS) caller that still passes one now gets an `InvalidArgumentError` instead of a silent all-periods query. Migrate point usage to a range:

  ```diff
  - client.register('AccumulationRegister_X').turnovers({ Period: someDate })
  + client.register('AccumulationRegister_X').turnovers({ Period: { from: someDate } })
  ```

  `balance()` is unchanged — it correctly uses a single-point `Period`.

### Patch Changes

- [#35](https://github.com/hacker-cb/1c-odata/pull/35) [`70cef5e`](https://github.com/hacker-cb/1c-odata/commit/70cef5e9066422c15871874b47f79cb06efdc777) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Fix four TS ↔ 1С conversion correctness issues:

  - **Nested entities are now parsed with their own schema.** Reading an `$expand`ed tabular part or nested ComplexType previously looked every field up in the _parent_ entity's schema, so a nested `Edm.Int64` stayed a string, a nested `Edm.DateTime` fell back to the regex heuristic, and nested ValueStorage triples were never grouped — even though the generated types promised converted values, and the write path already recursed with the nested type. The parser now resolves each nested field's own type (mirroring `write-transform`), and parses expanded navigation entities schema-less instead of bleeding the parent schema into them.
  - **ValueStorage round-trips on write.** The read side groups `<base>_Base64Data` + `<base>_Type` into a single `{ contentType, base64Data }` object; writing that object straight back (read → modify → `patch`) now splits it into the two wire halves 1С expects (the same shape `writeStream` PATCHes), instead of silently sending an unrecognized body. `validateOnWrite` now skips ValueStorage triple members, so the grouped form is no longer rejected when a `<base>_Type` half is declared non-nullable (which occurs in real 1С schemas).
  - **Numeric filter literals no longer use exponential notation.** `formatNumberLiteral` expanded small fractions / large magnitudes (e.g. `1e-7`, `1e21`) that JavaScript renders exponentially into plain decimal strings — OData V3 has no exponential numeric literal, so `f.field.eq(0.0000001)` previously produced an invalid `$filter` (HTTP 400 or a silent mismatch).
  - **Datetime milliseconds survive a round-trip.** `formatInZone` now keeps a non-zero millisecond component (`…:00.250`) instead of truncating to whole seconds, and `parseInZone` resolves the zone offset at second precision before re-applying the fraction — fixing both the silent write-side loss and a redundant offset recomputation for fractional inputs. Second-precision values (all standard 1С datetimes) are unchanged.

- [#37](https://github.com/hacker-cb/1c-odata/pull/37) [`8a09e92`](https://github.com/hacker-cb/1c-odata/commit/8a09e92b7422e4e855b1b3e9bf726f61bcd53d9b) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Internal DRY cleanup (no runtime behavior change):

  - Export `Int64Mode` and `DateMode` type aliases and a `DEFAULT_SHAPE` constant from `@1c-odata/client`. The `'number' | 'bigint' | 'string'` / `'date' | 'string'` union literals and the `int64Mode: 'number'` / `dateMode: 'date'` defaults were previously hand-duplicated across the runtime parser, write transform, `buildMetadataIndex`, and every codegen emitter; they now reference a single source, so the cross-layer `DataShape` contract can't silently drift.
  - Factor the composite-key tabular-header prefix match shared by `computeClosure` and `linkTabularParts` into one `findHeaderByPrefix` helper (the `_RecordType` companion handling, which intentionally differs between the two, stays at each call site).
  - Collapse the duplicated `entitySetToType → schemas` lookup in `ODataV3Client`'s `validateBeforeWrite` and write transform into a single `schemaForSet` helper.

  Byte-identical metadata output and unchanged public behavior are pinned by the existing `metadata-parity` and public-surface tests.

- [#38](https://github.com/hacker-cb/1c-odata/pull/38) [`4415ac4`](https://github.com/hacker-cb/1c-odata/commit/4415ac4dae057a5c5131aad18ddedc0a7ba738de) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Error/retry ergonomics:

  - **`ConcurrencyError` exposes the compared versions as structured fields.** The client-side optimistic-concurrency guard (`MutationOptions.expectVersion`) now populates `error.expectedVersion` and `error.actualVersion` instead of burying them in the message string, so callers can react to a conflict without parsing text. New `ConcurrencyErrorOptions` type. (Both fields are `undefined` on the rare path where a real HTTP 412 maps to this class.)
  - **Export a ready-made `DEFAULT_RETRY_POLICY`.** Assembling a `RetryPolicy` previously meant spelling out all seven fields by hand. `DEFAULT_RETRY_POLICY` covers the common case — 3 retries of idempotent methods (`GET`/`PUT`/`DELETE`/`PATCH`; `POST` excluded) on `502`/`503`/`504` with exponential backoff + full jitter. Pass it as `retry`, or spread it to tweak a field (`{ ...DEFAULT_RETRY_POLICY, maxRetries: 5 }`). It is frozen, so a direct import cannot retune retries process-wide. Retries remain off unless a policy is supplied.

- [#36](https://github.com/hacker-cb/1c-odata/pull/36) [`c48e6dc`](https://github.com/hacker-cb/1c-odata/commit/c48e6dcb661ddbd30a715f9292c36723fa900197) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Fail loudly with actionable errors on the dynamic / live-metadata path:

  - **`fetchMetadataXml` rejects non-EDMX responses.** The most common dynamic-mode failure — a wrong base URL, or an unauthenticated request redirected to an HTML login/portal page returning `200` — previously flowed into `parseEdmx` and surfaced as a cryptic `Expected <edmx:Edmx> root element`. It now throws a `MetadataError` naming the URL, status, content-type, and the first bytes of the body.
  - **`MetadataError` from `fetchMetadataIndex` carries request context.** A parse failure on a live `$metadata` now attaches the source URL (`error.request`), so a multi-target / multi-tenant setup can tell which base produced the bad XML.
  - **`ODataV3Client` validates IANA timezone validity in its constructor**, not just presence. A client built directly via `new ODataV3Client({...})` (bypassing `validateConnection`) with a bogus `serverTimezone` now throws `InvalidArgumentError` immediately instead of silently shifting every parsed/written `DateTime`.

## 0.3.0

### Minor Changes

- [#12](https://github.com/hacker-cb/1c-odata/pull/12) [`0fff3c8`](https://github.com/hacker-cb/1c-odata/commit/0fff3c877f31526af8301646f3aa9663f5907f7c) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Filter DSL chaining is now correctly typed. Methods that return an expression (`f.Date.year()`, `f.Сумма.add(5)`, `concat`, `substring`, `cast`, `dateadd`, …) previously returned the bare branded `FieldExpr<V>` with no operator surface, so chains like `f.Date.year().eq(2025)` — the README example — failed to compile against the public types (the runtime Proxy always worked). They now return the new `ChainedFieldExpr<V>` (brand + operators), and `FieldExprMap` property access carries the brand, so field proxies type-check as arguments to `any`/`all` and operator parameters.

- [#9](https://github.com/hacker-cb/1c-odata/pull/9) [`39e3003`](https://github.com/hacker-cb/1c-odata/commit/39e3003a1f287d0cf21ed519699379cc04774c1e) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Schema-less write correctness. `Date` instances in write payloads now convert to naive ISO in `serverTimezone` even without a `metadataIndex` (and for entity sets / fields missing from a loaded index — forward-compat with newer server schemas). Previously they serialized as UTC strings with a `Z` suffix, which 1С reads as a shifted wall-clock time. `bigint` values now serialize as the Edm.Int64 wire string everywhere (previously `JSON.stringify` threw `TypeError`, breaking the `int64Mode: 'bigint'` read → write round-trip even WITH a schema). `null` without a schema stays `null` — pass `ONEC_EMPTY_DATE` explicitly to clear a date. `shape: { dateMode: 'string' }` disables all date handling on both paths, as before.

  Migration: if you relied on the UTC-`Z` passthrough, set `shape: { dateMode: 'string' }` or pass pre-formatted strings.

- [#9](https://github.com/hacker-cb/1c-odata/pull/9) [`39e3003`](https://github.com/hacker-cb/1c-odata/commit/39e3003a1f287d0cf21ed519699379cc04774c1e) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Schema-less usage helpers: new `UntypedEntity` type (typed 1С system fields + open index signature) for `query<UntypedEntity>(...)` without codegen, and `parseMetadataIndex(data, source?)` — the pure validation core of `loadMetadataIndex` for reviving a `MetadataIndex` from caches or other non-file transports.

## 0.2.0

### Minor Changes

- [#5](https://github.com/hacker-cb/1c-odata/pull/5) [`7383109`](https://github.com/hacker-cb/1c-odata/commit/73831096eefbc3fa45b30874b69221d3cc58f244) Thanks [@hacker-cb](https://github.com/hacker-cb)! - **Reject `NaN` / `Infinity` in numeric literals (silent data loss fix).**

  `$filter` numeric operators (`eq`, `gt`, `add`, etc.) and `FunctionImport` argument
  serialization previously formatted `NaN` / `+Infinity` / `-Infinity` as the bare
  strings `NaN` / `Infinity` / `-Infinity`. None of these are valid OData V3 literals
  — 1С either rejected them with HTTP 400 or (in the worst case) returned spurious
  results as if the comparison had been dropped.

  These three values now throw `InvalidArgumentError` synchronously when constructing
  the query, with `argument` pointing at the offending field name or FI parameter.

  **Migration:**

  - Code paths that always pass finite numbers are unaffected.
  - Callers that derive numeric inputs from reductions over potentially-empty arrays
    (e.g. `Math.max(...arr)` → `-Infinity` when `arr === []`) must guard before
    passing the value to the DSL.

  **Also removes `mapResponseToError` from the public API.**

  This helper was exported from `@1c-odata/client` but never listed in `STABILITY.md`.
  It is now `@internal` — still used by the library's transport internally, but no
  longer part of the documented surface. The 1С platform-specific error decision
  tree (500+code"-1" → `BusinessError`, 401 → `PermissionError`, 412 →
  `ConcurrencyError`, etc.) is still applied automatically to every request; consumers
  catch the resulting typed `ODataError` subclass as before.

  If you imported `mapResponseToError` directly, replace it with a `try { ... } catch (e) { if (e instanceof BusinessError) ... }` flow at the call site.

## 0.1.0

### Minor Changes

- [#2](https://github.com/hacker-cb/1c-odata/pull/2) [`ee75158`](https://github.com/hacker-cb/1c-odata/commit/ee75158ff4e8b3b57fb1e17963ae1fc3621c42f8) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Initial public release. API is pre-1.0 and unstable — see [STABILITY.md](https://github.com/hacker-cb/1c-odata/blob/master/STABILITY.md) for the semver policy, public surface, and error / connection / codegen contracts.
