# @1c-odata/client

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
