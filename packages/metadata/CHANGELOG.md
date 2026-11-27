# @1c-odata/metadata

## 0.13.0

### Minor Changes

- [#288](https://github.com/hacker-cb/1c-odata/pull/288) [`7e7129d`](https://github.com/hacker-cb/1c-odata/commit/7e7129dde5374ec09c9c2c8fba490d6157507269) Thanks [@hacker-cb](https://github.com/hacker-cb)! - An entity an `$expand` brings is parsed with the schema of its own type, as the row is ([#283](https://github.com/hacker-cb/1c-odata/issues/283)). The index held no navigation properties, so the parser found no type for an expanded field and read the entity schema-less: under the default `int64Mode: 'number'` an `Edm.Int64` stayed the wire string (`"5"`, where codegen types the field `number`), a malformed one (`"12x"`) passed unchecked, `Edm.DateTime` went by the string heuristic alone, and a ValueStorage pair stayed flat.

  `buildMetadataIndex` (so `fetchMetadataIndex`, `createDynamicClient` and codegen's `__metadata.json`) now records each EntityType's navigation properties in a new optional field, `EntitySchema.navigation` — `{ [name]: { type, collection? } }`, `type` being the target's local name and `collection: true` only for a to-many end, which 1С never declares. Only a navigation whose target the index holds is written; the key goes after `valueStorages`, the rest of `__metadata.json` stays byte-for-byte as it was (+7–11 % in size for a full base). `parseMetadataIndex` / `loadMetadataIndex` refuse a malformed `navigation` with `MetadataError`; one naming a type the index lacks reads that expanded value schema-less instead of failing the index. `NavigationSchema` is exported as a type.

  The parser resolves an expanded field through it: an expanded entity, and each entity of an expanded collection, reads with its target's schema, exactly as a row does — `Edm.Int64` converted per `int64Mode` and, in `'number'` / `'bigint'`, refused when it is no 64-bit integer; `Edm.DateTime` converted by the schema and, in `dateMode: 'date'`, refused when it names no real date-time; an `Edm.String` that looks like a date left a string; ValueStorage grouped. The `'string'` modes pass values through untouched, as they do for the row.

  **Migration:** regenerate `__metadata.json` (`1c-odata generate`) or refetch a cached index to get the new behaviour — an index without `navigation` still loads and reads expanded entities schema-less, as before. With a new index, code that read an expanded `Edm.Int64` as a string gets a `number` (or `bigint`) now, and a reply whose expanded entity breaks its schema is a `ParseError`.

- [#294](https://github.com/hacker-cb/1c-odata/pull/294) [`f433f82`](https://github.com/hacker-cb/1c-odata/commit/f433f820d62bf16f5af7f3d43ded47e8ed21148f) Thanks [@hacker-cb](https://github.com/hacker-cb)! - A ValueStorage in a tabular part's row arrives as `{ contentType, base64Data }` (or `null`), as codegen types it ([#290](https://github.com/hacker-cb/1c-odata/issues/290)). `buildMetadataIndex` listed `valueStorages` for EntityTypes only, while 1С declares storages in tabular row types too (`<Doc>_<Part>_RowType`, a ComplexType — 86 of them in УТ 11.5, 314 tabular parts with one in БП 3.0); the parser reads a row by that type, so its halves stayed flat — and under `nometadata` the `_Type` never came ([#289](https://github.com/hacker-cb/1c-odata/issues/289)).

  - `buildMetadataIndex` (so `fetchMetadataIndex`, `createDynamicClient` and codegen's `__metadata.json`) lists `valueStorages` for ComplexTypes too — `__metadata.json` gains the key on those row types, nothing else changes.
  - A read asks for `minimalmetadata` ([#289](https://github.com/hacker-cb/1c-odata/issues/289)) where a tabular part with a storage comes back: an empty `$select`, `*` (not `**`, which leaves tabular parts out), the part named bare or with `/*` / `/**`, or `<Part>/<base or half>`.
  - A `$select` of `<Part>/<base>` is written as its two halves ([#286](https://github.com/hacker-cb/1c-odata/issues/286)) — through an untyped query: a codegen-typed `select()` takes the entity's own keys, the part (`Товары`) among them, not a path.

  Codegen's types do not change: a tabular row was already typed with the storage as `ValueStorage | null`.

  **Migration:** regenerate `__metadata.json` (or refetch a cached index). A tabular row that carried `<X>_Base64Data` as a plain field carries `<X>` instead.

### Patch Changes

- [#281](https://github.com/hacker-cb/1c-odata/pull/281) [`5749192`](https://github.com/hacker-cb/1c-odata/commit/574919252281f4250df34e8f3711fd7f729250c7) Thanks [@hacker-cb](https://github.com/hacker-cb)! - A key named `__proto__` — in a response body, a write payload or an EDMX — is an own field of the object it belongs to, never its prototype ([#275](https://github.com/hacker-cb/1c-odata/issues/275)).

  The parser copied each field of a row into `{}` by assignment, so a body like `{"value":[{"__proto__":{"x":1},"a":2}]}` gave a row with the keys `['a']` whose `row.x` was `1`; nested objects and tabular rows did the same, and so did the write transform on a payload carrying such a field. `buildMetadataIndex` wrote type, property and entity-set names the same way, so an EDMX type named `__proto__` replaced the prototype of `schemas` and left `entitySetToType` naming a type `parseMetadataIndex` then refused, failing the whole index.

  Such a key is now defined as an ordinary own field. Rows, payloads, `schemas`, `entitySetToType` and each type's `properties` keep their plain `Object` prototype — `row.hasOwnProperty` works as before — and the field serializes back as it came (`enums` stays the null-prototype dictionary it was). Nothing changes for 1С, which sends no such names: `__metadata.json` of a real base is byte-for-byte the same.

  `validateOnWrite` (`validateEntity`) counts a property whose name `Object.prototype` carries (`__proto__`, `constructor`, …) only as the payload's own field: a non-nullable one the payload lacked read `Object.prototype` / `Object` and passed its `required` check. Every other name reads as before.

  `buildMetadataIndex` lists in `entitySetToType` only the sets whose type `schemas` holds. An EntitySet whose type lies in another namespace or is missing from the EDMX was listed under a type no schema stands for, and `parseMetadataIndex` refuses such an index whole — a `__metadata.json` codegen emitted for that EDMX would not load. Such a set reads and writes schema-less either way; 1С's EDMX has none, so the index of a real base does not change.

- Updated dependencies [[`7e7129d`](https://github.com/hacker-cb/1c-odata/commit/7e7129dde5374ec09c9c2c8fba490d6157507269), [`6818921`](https://github.com/hacker-cb/1c-odata/commit/6818921ad2784f919841b6625822015309a4019b), [`6818921`](https://github.com/hacker-cb/1c-odata/commit/6818921ad2784f919841b6625822015309a4019b), [`60c8278`](https://github.com/hacker-cb/1c-odata/commit/60c82789df54ae352e6c58c4da9a772a52ee0270), [`5749192`](https://github.com/hacker-cb/1c-odata/commit/574919252281f4250df34e8f3711fd7f729250c7), [`829bfc5`](https://github.com/hacker-cb/1c-odata/commit/829bfc5f5dcb6596a7ba81a1d15d126ff3e8277e), [`7e7129d`](https://github.com/hacker-cb/1c-odata/commit/7e7129dde5374ec09c9c2c8fba490d6157507269), [`f433f82`](https://github.com/hacker-cb/1c-odata/commit/f433f820d62bf16f5af7f3d43ded47e8ed21148f), [`60c8278`](https://github.com/hacker-cb/1c-odata/commit/60c82789df54ae352e6c58c4da9a772a52ee0270), [`4f500c9`](https://github.com/hacker-cb/1c-odata/commit/4f500c90f226f96d103f0daf032b131fa4047e06)]:
  - @1c-odata/client@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [[`b941e19`](https://github.com/hacker-cb/1c-odata/commit/b941e19ad30478fa98642a609b5d20692e6dc175), [`b80c9e8`](https://github.com/hacker-cb/1c-odata/commit/b80c9e85a963feca8bbd7d26c8580b10efbb59cd), [`b80c9e8`](https://github.com/hacker-cb/1c-odata/commit/b80c9e85a963feca8bbd7d26c8580b10efbb59cd), [`b941e19`](https://github.com/hacker-cb/1c-odata/commit/b941e19ad30478fa98642a609b5d20692e6dc175)]:
  - @1c-odata/client@0.12.0

## 0.11.1

### Patch Changes

- Updated dependencies [[`687d1b4`](https://github.com/hacker-cb/1c-odata/commit/687d1b46b1a6e576ab0d6c8a81c57768cd4b833c)]:
  - @1c-odata/client@0.11.1

## 0.11.0

### Patch Changes

- Updated dependencies [[`46a34c1`](https://github.com/hacker-cb/1c-odata/commit/46a34c1a9235262a03ddf957950cab88fa6732ae), [`f3d172d`](https://github.com/hacker-cb/1c-odata/commit/f3d172d131178aa0515f53eb943debe43ee14b71), [`aa0b7c9`](https://github.com/hacker-cb/1c-odata/commit/aa0b7c94ec502e24dd20c2d513385cd953c2fdae), [`815c221`](https://github.com/hacker-cb/1c-odata/commit/815c221cbf3e596039bb5c7a595c365bc8656a8d), [`e629dcc`](https://github.com/hacker-cb/1c-odata/commit/e629dccc502d43baf73d40ddaa2cb67726f9b24f), [`f79571c`](https://github.com/hacker-cb/1c-odata/commit/f79571c6aca37e8bc3f03c3d71545c9f87dadd61), [`f3d172d`](https://github.com/hacker-cb/1c-odata/commit/f3d172d131178aa0515f53eb943debe43ee14b71), [`f3d172d`](https://github.com/hacker-cb/1c-odata/commit/f3d172d131178aa0515f53eb943debe43ee14b71)]:
  - @1c-odata/client@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [[`7107749`](https://github.com/hacker-cb/1c-odata/commit/71077490251dd188f72fde6e28be5be50a69d6dc), [`e57da5a`](https://github.com/hacker-cb/1c-odata/commit/e57da5ac51a9bfde50071c58ae5e83cee789c1ae), [`7f48030`](https://github.com/hacker-cb/1c-odata/commit/7f48030e7156536b2f05afe469f721d866a4c7cf), [`b37d5e2`](https://github.com/hacker-cb/1c-odata/commit/b37d5e22700755823969638a2044a199bfa44bf9), [`b37d5e2`](https://github.com/hacker-cb/1c-odata/commit/b37d5e22700755823969638a2044a199bfa44bf9), [`b37d5e2`](https://github.com/hacker-cb/1c-odata/commit/b37d5e22700755823969638a2044a199bfa44bf9), [`b37d5e2`](https://github.com/hacker-cb/1c-odata/commit/b37d5e22700755823969638a2044a199bfa44bf9), [`b09961c`](https://github.com/hacker-cb/1c-odata/commit/b09961cb9fa556462bc95b2163bbdda00f297fb5), [`fdbd37c`](https://github.com/hacker-cb/1c-odata/commit/fdbd37c0ba36a9857a509dc2c89d989cb9eeda9b)]:
  - @1c-odata/client@0.10.0

## 0.9.1

### Patch Changes

- Updated dependencies [[`5b7df24`](https://github.com/hacker-cb/1c-odata/commit/5b7df24d16b07d8c6775a589523c3ac09efdd67f), [`6c9aa0d`](https://github.com/hacker-cb/1c-odata/commit/6c9aa0dcb153d1ba3b6a308651d90c40685d688c), [`6dd16fe`](https://github.com/hacker-cb/1c-odata/commit/6dd16fe27544cd8fcf7d612a2773331a974d74dd), [`8d973aa`](https://github.com/hacker-cb/1c-odata/commit/8d973aa5cf636d8d214bb1fbb99f9fe1e62d08d2)]:
  - @1c-odata/client@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [[`496ab3d`](https://github.com/hacker-cb/1c-odata/commit/496ab3d631da878443a418b22958875889e0a23c), [`81ee92b`](https://github.com/hacker-cb/1c-odata/commit/81ee92b7885c2082b467558773743ecc7c9e49f0), [`29996ce`](https://github.com/hacker-cb/1c-odata/commit/29996ce439d8651d36480d5791a0bbb65b3fd97e), [`1f23acd`](https://github.com/hacker-cb/1c-odata/commit/1f23acd3d1f12965fb6e70fa0b9c54f0c5e8c7b7), [`28ddb8a`](https://github.com/hacker-cb/1c-odata/commit/28ddb8ae0d03ed02784b654645c544225e9660dd), [`59ace8d`](https://github.com/hacker-cb/1c-odata/commit/59ace8d4599602d21b65f416239f515a2c57f610), [`bc82f74`](https://github.com/hacker-cb/1c-odata/commit/bc82f740a603a3df4f20be876ab86d3a135c73fe)]:
  - @1c-odata/client@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [[`7432911`](https://github.com/hacker-cb/1c-odata/commit/7432911062c53652241da8f86d45b0358c6c7e56), [`d717164`](https://github.com/hacker-cb/1c-odata/commit/d7171641b4eaa907d3b859b61ff9f554e2559aa4), [`a2334fd`](https://github.com/hacker-cb/1c-odata/commit/a2334fd33035bd6f55b6ae5c8d477b9b116982c2)]:
  - @1c-odata/client@0.8.0

## 0.7.0

### Minor Changes

- [#126](https://github.com/hacker-cb/1c-odata/pull/126) [`3146289`](https://github.com/hacker-cb/1c-odata/commit/3146289e4304b1ea5bf531be6a8496456c6cf228) Thanks [@hacker-cb](https://github.com/hacker-cb)! - **Breaking:** the minimum supported Node version is now 24.18.0 (was 22.21.0).

  Node 22 "Jod" has left active LTS and is in maintenance; Node 24 "Krypton" is
  the active LTS line and is supported until 2028-04-30. Installing on Node 22
  will now be refused or warned about by npm/pnpm, depending on your client.

  No source change accompanies this. The library does not yet use any API that
  Node 22 lacks — the floor moves so that the version CI exercises and the version
  the packages advertise are one and the same. Keeping the advertised floor below the tested one meant the
  promise was never actually verified, which is the defect this closes.

  `@types/node` is pinned to the matching major for the same reason: types
  describing a runtime above the floor let an API that does not exist there
  typecheck green and fail at runtime for anyone who installed at the advertised
  minimum.

  If you are pinned to Node 22, stay on the previous release until you can move —
  v0.x carries no compatibility shims (see STABILITY.md).

### Patch Changes

- Updated dependencies [[`3146289`](https://github.com/hacker-cb/1c-odata/commit/3146289e4304b1ea5bf531be6a8496456c6cf228)]:
  - @1c-odata/client@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies []:
  - @1c-odata/client@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [[`bc33cc0`](https://github.com/hacker-cb/1c-odata/commit/bc33cc0733238ee241d3106b9854c78bf02fb62b)]:
  - @1c-odata/client@0.5.0

## 0.4.1

### Patch Changes

- [#39](https://github.com/hacker-cb/1c-odata/pull/39) [`b187b01`](https://github.com/hacker-cb/1c-odata/commit/b187b014074601526a49928c74a3064feede3b12) Thanks [@hacker-cb](https://github.com/hacker-cb)! - fix(release): publish via `pnpm pack` so `workspace:*` deps are rewritten to concrete versions

  The release workflow published with `npm publish`, which does not rewrite the
  `workspace:` protocol. As a result `@1c-odata/metadata` and `@1c-odata/cli` (and
  transitively `@1c-odata/mcp`) shipped with `"@1c-odata/client": "workspace:*"` in
  their published manifests and were uninstallable from npm (`EUNSUPPORTEDPROTOCOL`).
  The workflow now publishes a `pnpm pack` tarball, which rewrites workspace deps to
  the released version, so a plain `npm install` / `npx` resolves them. (`@1c-odata/client`
  is dependency-free and was unaffected; it bumps with the fixed group.)

- Updated dependencies [[`b187b01`](https://github.com/hacker-cb/1c-odata/commit/b187b014074601526a49928c74a3064feede3b12)]:
  - @1c-odata/client@0.4.1

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
