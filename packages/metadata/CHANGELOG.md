# @1c-odata/metadata

## 0.3.0

### Minor Changes

- [#7](https://github.com/hacker-cb/1c-odata/pull/7) [`2867f7d`](https://github.com/hacker-cb/1c-odata/commit/2867f7d987c18d26bc1b43cadc4cf16c40c7edce) Thanks [@hacker-cb](https://github.com/hacker-cb)! - New package: 1С OData V3 schema toolkit. Parse `$metadata` (EDMX XML) with `parseEdmx`, build a runtime `MetadataIndex` with `buildMetadataIndex(model, { shape, filter })` — the same structure codegen emits as `__metadata.json`, now available at runtime without generating TypeScript files. Also exposes the schema-analysis helpers previously internal to codegen: entity-kind classification (`classifyEntity`, `KIND_ORDER`, `KIND_TO_FOLDER`, `tailName`), dependency closure (`computeClosure`), tabular-part linking (`linkTabularParts`), ValueStorage detection (`detectValueStorage`), and function-import grouping (`groupFunctionImportsByEntitySet`).

- [#9](https://github.com/hacker-cb/1c-odata/pull/9) [`39e3003`](https://github.com/hacker-cb/1c-odata/commit/39e3003a1f287d0cf21ed519699379cc04774c1e) Thanks [@hacker-cb](https://github.com/hacker-cb)! - Runtime mode: connect to any 1С base with zero generated files. New `fetchMetadataXml(opts)` (download `$metadata` with typed transport errors), `fetchMetadataIndex(conn, opts?)` (download → parse → `buildMetadataIndex` in one step, honoring `conn.shape` and an optional entity filter), and `createDynamicClient(conn, opts?)` (the above plus a ready `ODataV3Client` — full date / Int64 / ValueStorage handling and optional `validateOnWrite`). The index is plain JSON — cache it with `JSON.stringify` and revive via `parseMetadataIndex` from `@1c-odata/client`.

### Patch Changes

- Updated dependencies [[`0fff3c8`](https://github.com/hacker-cb/1c-odata/commit/0fff3c877f31526af8301646f3aa9663f5907f7c), [`39e3003`](https://github.com/hacker-cb/1c-odata/commit/39e3003a1f287d0cf21ed519699379cc04774c1e), [`39e3003`](https://github.com/hacker-cb/1c-odata/commit/39e3003a1f287d0cf21ed519699379cc04774c1e)]:
  - @1c-odata/client@0.3.0
