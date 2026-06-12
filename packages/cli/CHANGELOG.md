# @1c-odata/cli

## 0.3.0

### Minor Changes

- [#7](https://github.com/hacker-cb/1c-odata/pull/7) [`2867f7d`](https://github.com/hacker-cb/1c-odata/commit/2867f7d987c18d26bc1b43cadc4cf16c40c7edce) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Codegen now consumes `@1c-odata/metadata` for EDMX parsing, schema analysis, and the runtime sections of `__metadata.json` (`buildMetadataIndex` is the single source of truth shared with runtime consumers; emitted JSON is byte-identical). Dependency changes: `fast-xml-parser` moved to `@1c-odata/metadata`, which is now a dependency of the CLI. The public API (`1c-odata` binary, `@1c-odata/cli/codegen` exports) is unchanged; only unsupported deep imports of internal parser/analysis modules would need updating.

- [#9](https://github.com/hacker-cb/1c-odata/pull/9) [`39e3003`](https://github.com/hacker-cb/1c-odata/commit/39e3003a1f287d0cf21ed519699379cc04774c1e) Thanks [@hacker-cb](https://github.com/hacker-cb)! - `1c-odata generate --metadata-only` emits just `__metadata.json` (no TypeScript files) — a pinned runtime schema for `validateOnWrite` / date / Int64 parsing without generating thousands of types and without fetching `$metadata` at process startup. The flag participates in the smart-skip input hash, so switching modes regenerates correctly.

### Patch Changes

- Updated dependencies [[`2867f7d`](https://github.com/hacker-cb/1c-odata/commit/2867f7d987c18d26bc1b43cadc4cf16c40c7edce), [`0fff3c8`](https://github.com/hacker-cb/1c-odata/commit/0fff3c877f31526af8301646f3aa9663f5907f7c), [`39e3003`](https://github.com/hacker-cb/1c-odata/commit/39e3003a1f287d0cf21ed519699379cc04774c1e), [`39e3003`](https://github.com/hacker-cb/1c-odata/commit/39e3003a1f287d0cf21ed519699379cc04774c1e), [`39e3003`](https://github.com/hacker-cb/1c-odata/commit/39e3003a1f287d0cf21ed519699379cc04774c1e)]:
  - @1c-odata/metadata@0.3.0
  - @1c-odata/client@0.3.0

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

### Patch Changes

- Updated dependencies [[`7383109`](https://github.com/hacker-cb/1c-odata/commit/73831096eefbc3fa45b30874b69221d3cc58f244)]:
  - @1c-odata/client@0.2.0

## 0.1.0

### Minor Changes

- [#2](https://github.com/hacker-cb/1c-odata/pull/2) [`ee75158`](https://github.com/hacker-cb/1c-odata/commit/ee75158ff4e8b3b57fb1e17963ae1fc3621c42f8) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Initial public release. API is pre-1.0 and unstable — see [STABILITY.md](https://github.com/hacker-cb/1c-odata/blob/master/STABILITY.md) for the semver policy, public surface, and error / connection / codegen contracts.

### Patch Changes

- Updated dependencies [[`ee75158`](https://github.com/hacker-cb/1c-odata/commit/ee75158ff4e8b3b57fb1e17963ae1fc3621c42f8)]:
  - @1c-odata/client@0.1.0
