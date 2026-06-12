---
"@1c-odata/metadata": minor
---

New package: 1С OData V3 schema toolkit. Parse `$metadata` (EDMX XML) with `parseEdmx`, build a runtime `MetadataIndex` with `buildMetadataIndex(model, { shape, filter })` — the same structure codegen emits as `__metadata.json`, now available at runtime without generating TypeScript files. Also exposes the schema-analysis helpers previously internal to codegen: entity-kind classification (`classifyEntity`, `KIND_ORDER`, `KIND_TO_FOLDER`, `tailName`), dependency closure (`computeClosure`), tabular-part linking (`linkTabularParts`), ValueStorage detection (`detectValueStorage`), and function-import grouping (`groupFunctionImportsByEntitySet`).
