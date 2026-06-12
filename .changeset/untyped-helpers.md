---
"@1c-odata/client": minor
---

Schema-less usage helpers: new `UntypedEntity` type (typed 1С system fields + open index signature) for `query<UntypedEntity>(...)` without codegen, and `parseMetadataIndex(data, source?)` — the pure validation core of `loadMetadataIndex` for reviving a `MetadataIndex` from caches or other non-file transports.
