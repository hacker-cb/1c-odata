---
'@1c-odata/client': minor
---

A metadata index whose entity set names a type it does not hold is refused at load, and no lookup reads an inherited key as a schema (#258).

- **`parseMetadataIndex` / `loadMetadataIndex` throw a `MetadataError`** for an `entitySetToType` entry whose type is not an own key of `schemas` — `Invalid metadata at <source> $.entitySetToType.<Set>: type "<Type>" is not in $.schemas`. It used to load, and a type named after an inherited key (`constructor`, `toString`) then failed every read of that set with a `TypeError` on the first field of the first row. An index built by `buildMetadataIndex` / `fetchMetadataIndex` or emitted by `1c-odata generate` never holds such an entry: only a hand-edited or damaged cache does.

  **Migration:** none for a generated or fetched index. A cache that now fails to load is damaged — fetch or generate it again.
- **Every schema lookup takes own keys only** — reads (`get()`, `stream()`, entity reads, nested tabular parts and complex values), writes (`validateOnWrite`, the `Date` → wire transform, nested values included) and the filter DSL. A set or a type the index does not hold — an inherited name among them — reads and writes schema-less, as without an index, where an index passed straight to the client (not through `parseMetadataIndex`) used to fail with a `TypeError`. On write that includes a nested tabular part or complex value whose type the index does not hold: its `Date`s are written in the server's zone, found by value, where they used to go out as they were (`toJSON()`, UTC).
