# @1c-odata/cli

## 0.4.0

### Minor Changes

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

### Patch Changes

- [#34](https://github.com/hacker-cb/1c-odata/pull/34) [`62213ab`](https://github.com/hacker-cb/1c-odata/commit/62213ab3a360e42343fec7e3a02064d07bf205a7) Thanks [@hacker-cb](https://github.com/hacker-cb)! - `1c-odata generate --include` now narrows the emitted `__metadata.json` to the same dependency closure as the generated `.ts` files. Previously an `include` run emitted narrowed TypeScript but a full-base `__metadata.json`, so the runtime index described entities that had no generated types — diverging from `fetchMetadataIndex(conn, { filter })` and bloating metadata-only builds on large bases. The codegen and live-fetch index now agree for the same filter, restoring the "all schema sources produce identical runtime behavior" invariant. With no `include` the output is byte-identical to before.

- [#21](https://github.com/hacker-cb/1c-odata/pull/21) [`74e71e1`](https://github.com/hacker-cb/1c-odata/commit/74e71e19e47ea42b3f30e76ee4025ffecda29912) Thanks [@hacker-cb](https://github.com/hacker-cb)! - `1c-odata fetch` now downloads each target's `$metadata` concurrently (bounded to 4 in flight) instead of one base at a time. Fetching all targets previously paid the sum of every base's download latency; it now completes in roughly the slowest single base's time. Every target is still attempted when one fails (best-effort rather than stopping at the first error), and the first failure in target order is reported with its typed error identity (`HTTPError` / `PermissionError` / …) preserved.

- Updated dependencies [[`70cef5e`](https://github.com/hacker-cb/1c-odata/commit/70cef5e9066422c15871874b47f79cb06efdc777), [`8a09e92`](https://github.com/hacker-cb/1c-odata/commit/8a09e92b7422e4e855b1b3e9bf726f61bcd53d9b), [`27c207a`](https://github.com/hacker-cb/1c-odata/commit/27c207a770b6969872db5f07b7a334574313a12a), [`4415ac4`](https://github.com/hacker-cb/1c-odata/commit/4415ac4dae057a5c5131aad18ddedc0a7ba738de), [`c48e6dc`](https://github.com/hacker-cb/1c-odata/commit/c48e6dcb661ddbd30a715f9292c36723fa900197), [`f065038`](https://github.com/hacker-cb/1c-odata/commit/f0650388106795f5754d2f77574cfee8d45f50f9), [`968a14e`](https://github.com/hacker-cb/1c-odata/commit/968a14e3c52e70026a1c4eae5336d63c0ca386b3), [`b1507e8`](https://github.com/hacker-cb/1c-odata/commit/b1507e8c98bba793527cfdb8a07059b06628f983)]:
  - @1c-odata/client@0.4.0
  - @1c-odata/metadata@0.4.0

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
