---
"@1c-odata/client": minor
"@1c-odata/metadata": minor
---

Error-handling architecture: honest `HTTPError` envelope model, request context on every error, and a dedicated `MetadataError`.

- `ODataError` now carries `request?: { method, url }`, populated on every request-originated error (`HTTPError`, `NetworkError`, `TimeoutError`) so a caught error knows which call produced it. It excludes headers by design — the `Authorization` header never lands in logs. Errors not tied to a request (`InvalidArgumentError`, `ValidationError`, `MetadataError`) omit it.
- `HTTPError` no longer fabricates an OData body when the server didn't send one. `ErrorFormat` gains `'none'`; the parsed-envelope field is renamed `body` → `odata` and is now optional, as is `code` (both present only with a real JSON/XML `odata.error`); a new `rawBody` carries a truncated (≤512 char) snippet of the raw response. A non-2xx with no recognizable envelope (wrong entity-set path, missing base, over-long URL, HTML/proxy error page) now throws a real `HTTPError` with the status preserved and an actionable message — previously this surfaced as a `ParseError` that dropped the status code.
- New `MetadataError` (extends `ODataError`) for schema-metadata failures: `loadMetadataIndex` / `parseMetadataIndex` and `parseEdmx` now throw it instead of `ParseError`. `ParseError` is reserved for HTTP response-body parse failures. `@1c-odata/metadata` re-exports `MetadataError` and `ODataError` so consumers can catch without a separate `@1c-odata/client` import.
- `ConcurrencyError` from the client-side `expectVersion` guard no longer fabricates `errorFormat:'json'`/`body`/`code` — it reports `errorFormat:'none'` (no server response exists) while keeping `status: 412` and subclass identity.

**Breaking (v0.x):**

- `HTTPError.body` is renamed to `HTTPError.odata` and is now `ODataErrorBody | undefined`; `HTTPError.code` is now `string | undefined`. Guard before dereferencing (e.g. `err.odata?.message`).
- A 401/412 *without* an OData envelope now arrives as a generic `HTTPError` (with `status === 401`/`412`), not `PermissionError`/`ConcurrencyError`.
- `loadMetadataIndex` / `parseMetadataIndex` / `parseEdmx` now throw `MetadataError` instead of `ParseError`. Catch `MetadataError` for local metadata/EDMX failures, or `ODataError` to cover both domains.

`instanceof` identity, `HTTPError.status` (always present), and `Error.message` mutability are unchanged.
