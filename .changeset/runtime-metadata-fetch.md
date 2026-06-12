---
"@1c-odata/metadata": minor
---

Runtime mode: connect to any 1С base with zero generated files. New `fetchMetadataXml(opts)` (download `$metadata` with typed transport errors), `fetchMetadataIndex(conn, opts?)` (download → parse → `buildMetadataIndex` in one step, honoring `conn.shape` and an optional entity filter), and `createDynamicClient(conn, opts?)` (the above plus a ready `ODataV3Client` — full date / Int64 / ValueStorage handling and optional `validateOnWrite`). The index is plain JSON — cache it with `JSON.stringify` and revive via `parseMetadataIndex` from `@1c-odata/client`.
