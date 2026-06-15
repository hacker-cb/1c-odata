# Stability Policy

What is and isn't covered by semver across the `@1c-odata/*` monorepo.

## Public API surface

Public surface = every symbol reachable via a package's `package.json#exports` entrypoints (including subpaths like `@1c-odata/client/filter` and `@1c-odata/cli/codegen`), minus symbols tagged `@internal` in JSDoc. This covers all three packages: `@1c-odata/client`, `@1c-odata/metadata`, `@1c-odata/cli`.

Semver-applicable:

- Exports from each `package.json#exports` entrypoint and their exact signatures
- Public fields and methods on exported classes
- Option shapes: `ClientOptions`, `Connection`, `DataShape`, `RequestOptions`, `MutationOptions`, `RetryPolicy`, `RequestHooks`, `CodegenConfig`, `CodegenTarget`
- Top-level helpers: `parseConnectionUrl`, `validateConnection`, `clientOptionsFromConnection`, `defineConnection` (`@1c-odata/client`), `defineCodegenConfig` (`@1c-odata/cli`)
- Runtime metadata API of `@1c-odata/metadata`: `parseEdmx`, `buildMetadataIndex`, `fetchMetadataXml`, `fetchMetadataIndex`, `createDynamicClient` and their option shapes
- Programmatic codegen API of `@1c-odata/cli/codegen`: `generate` and its `GenerateInput` / `GenerateOptions` / `GenerateResult` shapes
- Layout and identifier names in `generated/<target>/<kind>/` produced by `@1c-odata/cli/codegen`

NOT covered:

- `@1c-odata/client/internal` — namespaced escape hatch for `@1c-odata/cli`, `@1c-odata/metadata`, and integration tests; MAY break in minor releases. Safe because all `@1c-odata/*` packages are in one changesets `fixed` group and always release in lock-step — published versions cannot drift against each other.
- Files under `src/internal.ts` or `src/internal/**`
- Identifiers tagged `@internal` (stripped from emitted `.d.ts` via `stripInternal`)
- Deep imports bypassing `exports` (e.g. `@1c-odata/client/dist/<file>.js`)
- Generated artifacts in consumer repositories (consumer re-runs `1c-odata generate` on bumps)
- Wire format details (server behavior derives from the 1С platform)

## Versioning

- **v0.x (current)** — API is unstable. Minor versions MAY contain breaking changes. Every break is documented in [GitHub Releases](https://github.com/hacker-cb/1c-odata/releases) with a migration example. Patch versions are NEVER breaking.
- **v1.0+ (future)** — strict semver.

Workspace deps use `workspace:*`. All three `@1c-odata/*` packages are one changesets `fixed` group, so they always release together at the same version. In v0.x a breaking change therefore ships as a **minor** bump across all three at once (a major bump is reserved for v1.0) — never as a major in 0.x.

## Error contract

`ODataError` and its subclasses (`HTTPError`, `BusinessError`, `ConcurrencyError`, `PermissionError`, `NetworkError`, `TimeoutError`, `ParseError`, `MetadataError`, `ValidationError`, `InvalidArgumentError`) are part of the stable public API.

Guaranteed:

- `instanceof ODataError` succeeds for every error the library originates. Caller-supplied `AbortSignal` aborts are the one carve-out: the underlying `AbortError` is rethrown unchanged — deliberately, so consumer `signal.aborted` / `e.name === 'AbortError'` checks keep working (library-issued timeout aborts still surface as `TimeoutError`).
- Subclass identity is stable across minor versions.
- Constructor signature `(message, options)` with `options extends { cause?: unknown }`. ES2022 `cause` chain is always forwarded.
- `ODataError.request` (`{ method, url }`) is set on errors that originate from an HTTP request — `HTTPError` and its subclasses (`BusinessError` / `ConcurrencyError` / `PermissionError`), `NetworkError`, `TimeoutError`, and a `ParseError` raised while mapping an HTTP error response — and `undefined` otherwise (`InvalidArgumentError`, `ValidationError`, a file-load `MetadataError`, or a `ParseError` from parsing a successful response body). It deliberately excludes headers, so the `Authorization` header never reaches a log.
- Structured fields on subclasses are stable. On `HTTPError`, `status` and `errorFormat` are always present; `code` and `odata` (the parsed 1С envelope) are present **only** when the server returned a recognizable `odata.error` (`errorFormat` `'json'`/`'xml'`) and are `undefined` for a non-OData response (`errorFormat: 'none'`), where `rawBody` instead holds a truncated snippet. Also stable: `TimeoutError.timeoutMs`, `ValidationError.issues`, `InvalidArgumentError.argument/received`.
- A non-2xx whose body is not a recognizable OData envelope (wrong entity-set path, over-long URL, HTML/proxy error page) surfaces as a generic `HTTPError` with the real `status` and `errorFormat: 'none'` — not a category subclass. A 401/412 *without* an envelope therefore arrives as `HTTPError` (with `status` 401/412), not `PermissionError`/`ConcurrencyError`.
- Schema-metadata failures — loading/validating a local `__metadata.json` (`loadMetadataIndex` / `parseMetadataIndex`) or parsing an EDMX `$metadata` document (`parseEdmx`) — throw `MetadataError`, distinct from the HTTP response-body `ParseError`.

NOT covered: internal errors of `@1c-odata/cli` (CLI output may change between versions); exact error message text — use class identity and structured fields for programmatic handling.

## Connection contract

`Connection` is part of the stable public API of `@1c-odata/client`.

Guaranteed:

- `Connection.serverTimezone` is required (`string`, no implicit default). Wrong timezone silently shifts DateTime parsing by hours; the library forces an explicit IANA choice.
- `validateConnection(c: unknown): asserts c is Connection` throws `InvalidArgumentError` with structured `argument`/`received` fields. Use for tests and dynamic configs.
- `connectionAuth(conn): AuthOptions` — single source of truth for `BasicAuth` construction from a Connection; both `clientOptionsFromConnection` and the CLI's `$metadata` download (`fetchMetadataXml`) route through it.

## Schema-less (untyped) contract

`ODataV3Client` works without a `metadataIndex`; the following behaviors are contract, not implementation detail:

- **Read:** `Edm.DateTime` wire strings are recognized by a regex heuristic and parsed via `serverTimezone`; the `0001-01-01T00:00:00` sentinel maps to `null`. `Edm.Int64` stays a wire **string** (type information requires a schema). ValueStorage triples stay flat (`<X>_Base64Data` + `<X>_Type`).
- **Write:** `Date` instances convert to naive ISO in `serverTimezone` (value heuristic — applies with no index, and to entity sets / fields missing from a loaded index). `bigint` serializes as the `Edm.Int64` wire string. `null` is passed through as-is — no sentinel without a schema; pass `ONEC_EMPTY_DATE` explicitly to clear a date.
- `shape: { dateMode: 'string' }` disables date handling on **both** paths.
- `validateOnWrite: true` without a `metadataIndex` throws `InvalidArgumentError` at construction.

`MetadataIndex` is a structural contract — the source is not specified: the codegen-emitted `__metadata.json` (`loadMetadataIndex`), an index built at runtime from `$metadata` (`buildMetadataIndex` / `fetchMetadataIndex` in `@1c-odata/metadata`), or a revived cache entry (`parseMetadataIndex`). All sources produce identical runtime behavior — pinned by the `metadata-parity` integration test.

## Codegen output

`generated/` is a derived artifact in the consumer's repo. We promise:

- Stable layout: `generated/<target>/<kind>/<Name>.ts`
- Stable exported type names (1:1 with 1С metadata identifiers)
- Per-target root files: `index.ts` (master reexport), `__metadata.json`, `client.ts`, and `enums.ts` (when EDMX declares any `EnumType`). Optional: `complex-types.ts`, `function-imports.ts`.
- A `<kind>/index.ts` re-export is emitted for every entity kind, always — kinds with no entities get an `export {}` stub so the import path stays stable.
- `enums.ts`: one `as const` object + literal-union type alias per `EnumType`. Names and member sets track the EDMX verbatim. Consumers cast property values explicitly because 1С V3 EDMX does not link `Edm.String` fields to their `EnumType`.

Layout / naming changes in `@1c-odata/cli/codegen` are a breaking change, versioned per the [Versioning](#versioning) policy above (a minor bump in v0.x, a major from v1.0). A consumer re-runs `1c-odata generate` and gets a diff in their repo.
