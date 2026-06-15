---
"@1c-odata/cli": patch
---

`1c-odata generate --include` now narrows the emitted `__metadata.json` to the same dependency closure as the generated `.ts` files. Previously an `include` run emitted narrowed TypeScript but a full-base `__metadata.json`, so the runtime index described entities that had no generated types — diverging from `fetchMetadataIndex(conn, { filter })` and bloating metadata-only builds on large bases. The codegen and live-fetch index now agree for the same filter, restoring the "all schema sources produce identical runtime behavior" invariant. With no `include` the output is byte-identical to before.
