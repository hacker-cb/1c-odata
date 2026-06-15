---
"@1c-odata/metadata": patch
"@1c-odata/client": patch
---

Fail loudly with actionable errors on the dynamic / live-metadata path:

- **`fetchMetadataXml` rejects non-EDMX responses.** The most common dynamic-mode failure — a wrong base URL, or an unauthenticated request redirected to an HTML login/portal page returning `200` — previously flowed into `parseEdmx` and surfaced as a cryptic `Expected <edmx:Edmx> root element`. It now throws a `MetadataError` naming the URL, status, content-type, and the first bytes of the body.
- **`MetadataError` from `fetchMetadataIndex` carries request context.** A parse failure on a live `$metadata` now attaches the source URL (`error.request`), so a multi-target / multi-tenant setup can tell which base produced the bad XML.
- **`ODataV3Client` validates IANA timezone validity in its constructor**, not just presence. A client built directly via `new ODataV3Client({...})` (bypassing `validateConnection`) with a bogus `serverTimezone` now throws `InvalidArgumentError` immediately instead of silently shifting every parsed/written `DateTime`.
