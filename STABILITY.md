# Stability Policy

What is and isn't covered by semver across the `@1c-odata/*` monorepo.

## Public API surface

Public surface = every symbol reachable via a package's `package.json#exports` entrypoints (including subpaths like `@1c-odata/client/filter` and `@1c-odata/cli/codegen`), minus symbols tagged `@internal` in JSDoc.

Semver-applicable:

- Exports from each `package.json#exports` entrypoint and their exact signatures
- Public fields and methods on exported classes
- Option shapes: `ClientOptions`, `Connection`, `DataShape`, `RequestOptions`, `MutationOptions`, `RetryPolicy`, `RequestHooks`, `CliConfig`
- Top-level helpers: `parseConnectionUrl`, `validateConnection`, `clientOptionsFromConnection`, `defineConfig`
- Layout and identifier names in `generated/<connection>/<kind>/` produced by `@1c-odata/cli/codegen`

NOT covered:

- `@1c-odata/client/internal` — namespaced escape hatch for `@1c-odata/cli` and integration tests; MAY break in minor releases
- Files under `src/internal.ts` or `src/internal/**`
- Identifiers tagged `@internal` (stripped from emitted `.d.ts` via `stripInternal`)
- Deep imports bypassing `exports` (e.g. `@1c-odata/client/dist/<file>.js`)
- Generated artifacts in consumer repositories (consumer re-runs `1c-odata generate` on bumps)
- Wire format details (server behavior derives from the 1С platform)

## Versioning

- **v0.x (current)** — API is unstable. Minor versions MAY contain breaking changes. Every break is documented in [GitHub Releases](https://github.com/hacker-cb/1c-odata/releases) with a migration example. Patch versions are NEVER breaking.
- **v1.0+ (future)** — strict semver.

Workspace deps use `workspace:*`. When `@1c-odata/client` introduces a breaking change, `@1c-odata/cli` bumps its major in the same Changeset.

## Error contract

`ODataError` and its subclasses (`HTTPError`, `BusinessError`, `ConcurrencyError`, `PermissionError`, `NetworkError`, `TimeoutError`, `ParseError`, `ValidationError`, `InvalidArgumentError`) are part of the stable public API.

Guaranteed:

- `instanceof ODataError` succeeds for every error the library originates. Caller-supplied `AbortSignal` aborts are the one carve-out: the underlying `AbortError` is rethrown unchanged (library-issued timeout aborts still surface as `TimeoutError`).
- Subclass identity is stable across minor versions.
- Constructor signature `(message, options)` with `options extends { cause?: unknown }`. ES2022 `cause` chain is always forwarded.
- Structured fields on subclasses (`HTTPError.status/code/body`, `TimeoutError.timeoutMs`, `ValidationError.issues`, `InvalidArgumentError.argument/received`) are stable.

NOT covered: internal errors of `@1c-odata/cli` (CLI output may change between versions); exact error message text — use class identity and structured fields for programmatic handling.

## Connection contract

`Connection` is part of the stable public API of `@1c-odata/client`.

Guaranteed:

- `Connection.serverTimezone` is required (`string`, no implicit default). Wrong timezone silently shifts DateTime parsing by hours; the library forces an explicit IANA choice.
- `validateConnection(c: unknown): asserts c is Connection` throws `InvalidArgumentError` with structured `argument`/`received` fields. Use for tests and dynamic configs.
- `connectionAuth(conn): AuthOptions` — single source of truth for `BasicAuth` construction from a Connection; both `clientOptionsFromConnection` and CLI `fetchMetadata` route through it.

## Codegen output

`generated/` is a derived artifact in the consumer's repo. We promise:

- Stable layout: `generated/<connection>/<kind>/<Name>.ts`
- Stable exported type names (1:1 with 1С metadata identifiers)
- Per-connection root files: `index.ts` (master reexport), `__metadata.json`, `client.ts`, and `enums.ts` (when EDMX declares any `EnumType`). Optional: `complex-types.ts`, `function-imports.ts`.
- `enums.ts`: one `as const` object + literal-union type alias per `EnumType`. Names and member sets track the EDMX verbatim. Consumers cast property values explicitly because 1С V3 EDMX does not link `Edm.String` fields to their `EnumType`.

Layout / naming changes in `@1c-odata/cli/codegen` bump major. Consumer re-runs `1c-odata generate` and gets a diff in their repo.
