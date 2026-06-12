---
"@1c-odata/client": minor
---

Schema-less write correctness. `Date` instances in write payloads now convert to naive ISO in `serverTimezone` even without a `metadataIndex` (and for entity sets / fields missing from a loaded index — forward-compat with newer server schemas). Previously they serialized as UTC strings with a `Z` suffix, which 1С reads as a shifted wall-clock time. `bigint` values now serialize as the Edm.Int64 wire string everywhere (previously `JSON.stringify` threw `TypeError`, breaking the `int64Mode: 'bigint'` read → write round-trip even WITH a schema). `null` without a schema stays `null` — pass `ONEC_EMPTY_DATE` explicitly to clear a date. `shape: { dateMode: 'string' }` disables all date handling on both paths, as before.

Migration: if you relied on the UTC-`Z` passthrough, set `shape: { dateMode: 'string' }` or pass pre-formatted strings.
