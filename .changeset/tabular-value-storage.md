---
'@1c-odata/client': minor
'@1c-odata/metadata': minor
---

A ValueStorage in a tabular part's row arrives as `{ contentType, base64Data }` (or `null`), as codegen types it (#290). `buildMetadataIndex` listed `valueStorages` for EntityTypes only, while 1С declares storages in tabular row types too (`<Doc>_<Part>_RowType`, a ComplexType — 86 of them in УТ 11.5, 314 tabular parts with one in БП 3.0); the parser reads a row by that type, so its halves stayed flat — and under `nometadata` the `_Type` never came (#289).

- `buildMetadataIndex` (so `fetchMetadataIndex`, `createDynamicClient` and codegen's `__metadata.json`) lists `valueStorages` for ComplexTypes too — `__metadata.json` gains the key on those row types, nothing else changes.
- A read asks for `minimalmetadata` (#289) where a tabular part with a storage comes back: an empty `$select`, `*` (not `**`, which leaves tabular parts out), the part named bare or with `/*` / `/**`, or `<Part>/<base or half>`.
- A `$select` of `<Part>/<base>` is written as its two halves (#286) — through an untyped query: a codegen-typed `select()` takes the entity's own keys, the part (`Товары`) among them, not a path.

Codegen's types do not change: a tabular row was already typed with the storage as `ValueStorage | null`.

**Migration:** regenerate `__metadata.json` (or refetch a cached index). A tabular row that carried `<X>_Base64Data` as a plain field carries `<X>` instead.
