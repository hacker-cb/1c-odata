---
"@1c-odata/client": patch
---

Internal DRY cleanup (no runtime behavior change):

- Export `Int64Mode` and `DateMode` type aliases and a `DEFAULT_SHAPE` constant from `@1c-odata/client`. The `'number' | 'bigint' | 'string'` / `'date' | 'string'` union literals and the `int64Mode: 'number'` / `dateMode: 'date'` defaults were previously hand-duplicated across the runtime parser, write transform, `buildMetadataIndex`, and every codegen emitter; they now reference a single source, so the cross-layer `DataShape` contract can't silently drift.
- Factor the composite-key tabular-header prefix match shared by `computeClosure` and `linkTabularParts` into one `findHeaderByPrefix` helper (the `_RecordType` companion handling, which intentionally differs between the two, stays at each call site).
- Collapse the duplicated `entitySetToType → schemas` lookup in `ODataV3Client`'s `validateBeforeWrite` and write transform into a single `schemaForSet` helper.

Byte-identical metadata output and unchanged public behavior are pinned by the existing `metadata-parity` and public-surface tests.
