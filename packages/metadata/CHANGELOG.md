# @1c-odata/metadata

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

- [#36](https://github.com/hacker-cb/1c-odata/pull/36) [`c48e6dc`](https://github.com/hacker-cb/1c-odata/commit/c48e6dcb661ddbd30a715f9292c36723fa900197) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Fail loudly with actionable errors on the dynamic / live-metadata path:

  - **`fetchMetadataXml` rejects non-EDMX responses.** The most common dynamic-mode failure — a wrong base URL, or an unauthenticated request redirected to an HTML login/portal page returning `200` — previously flowed into `parseEdmx` and surfaced as a cryptic `Expected <edmx:Edmx> root element`. It now throws a `MetadataError` naming the URL, status, content-type, and the first bytes of the body.
  - **`MetadataError` from `fetchMetadataIndex` carries request context.** A parse failure on a live `$metadata` now attaches the source URL (`error.request`), so a multi-target / multi-tenant setup can tell which base produced the bad XML.
  - **`ODataV3Client` validates IANA timezone validity in its constructor**, not just presence. A client built directly via `new ODataV3Client({...})` (bypassing `validateConnection`) with a bogus `serverTimezone` now throws `InvalidArgumentError` immediately instead of silently shifting every parsed/written `DateTime`.

- Updated dependencies [[`70cef5e`](https://github.com/hacker-cb/1c-odata/commit/70cef5e9066422c15871874b47f79cb06efdc777), [`8a09e92`](https://github.com/hacker-cb/1c-odata/commit/8a09e92b7422e4e855b1b3e9bf726f61bcd53d9b), [`27c207a`](https://github.com/hacker-cb/1c-odata/commit/27c207a770b6969872db5f07b7a334574313a12a), [`4415ac4`](https://github.com/hacker-cb/1c-odata/commit/4415ac4dae057a5c5131aad18ddedc0a7ba738de), [`c48e6dc`](https://github.com/hacker-cb/1c-odata/commit/c48e6dcb661ddbd30a715f9292c36723fa900197), [`f065038`](https://github.com/hacker-cb/1c-odata/commit/f0650388106795f5754d2f77574cfee8d45f50f9), [`968a14e`](https://github.com/hacker-cb/1c-odata/commit/968a14e3c52e70026a1c4eae5336d63c0ca386b3), [`b1507e8`](https://github.com/hacker-cb/1c-odata/commit/b1507e8c98bba793527cfdb8a07059b06628f983)]:
  - @1c-odata/client@0.4.0

## 0.3.0

### Minor Changes

- [#7](https://github.com/hacker-cb/1c-odata/pull/7) [`2867f7d`](https://github.com/hacker-cb/1c-odata/commit/2867f7d987c18d26bc1b43cadc4cf16c40c7edce) Thanks [@hacker-cb](https://github.com/hacker-cb)! - New package: 1С OData V3 schema toolkit. Parse `$metadata` (EDMX XML) with `parseEdmx`, build a runtime `MetadataIndex` with `buildMetadataIndex(model, { shape, filter })` — the same structure codegen emits as `__metadata.json`, now available at runtime without generating TypeScript files. Also exposes the schema-analysis helpers previously internal to codegen: entity-kind classification (`classifyEntity`, `KIND_ORDER`, `KIND_TO_FOLDER`, `tailName`), dependency closure (`computeClosure`), tabular-part linking (`linkTabularParts`), ValueStorage detection (`detectValueStorage`), and function-import grouping (`groupFunctionImportsByEntitySet`).

- [#9](https://github.com/hacker-cb/1c-odata/pull/9) [`39e3003`](https://github.com/hacker-cb/1c-odata/commit/39e3003a1f287d0cf21ed519699379cc04774c1e) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Runtime mode: connect to any 1С base with zero generated files. New `fetchMetadataXml(opts)` (download `$metadata` with typed transport errors), `fetchMetadataIndex(conn, opts?)` (download → parse → `buildMetadataIndex` in one step, honoring `conn.shape` and an optional entity filter), and `createDynamicClient(conn, opts?)` (the above plus a ready `ODataV3Client` — full date / Int64 / ValueStorage handling and optional `validateOnWrite`). The index is plain JSON — cache it with `JSON.stringify` and revive via `parseMetadataIndex` from `@1c-odata/client`.

### Patch Changes

- Updated dependencies [[`0fff3c8`](https://github.com/hacker-cb/1c-odata/commit/0fff3c877f31526af8301646f3aa9663f5907f7c), [`39e3003`](https://github.com/hacker-cb/1c-odata/commit/39e3003a1f287d0cf21ed519699379cc04774c1e), [`39e3003`](https://github.com/hacker-cb/1c-odata/commit/39e3003a1f287d0cf21ed519699379cc04774c1e)]:
  - @1c-odata/client@0.3.0
