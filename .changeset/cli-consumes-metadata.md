---
"@1c-odata/cli": minor
---

Codegen now consumes `@1c-odata/metadata` for EDMX parsing, schema analysis, and the runtime sections of `__metadata.json` (`buildMetadataIndex` is the single source of truth shared with runtime consumers; emitted JSON is byte-identical). Dependency changes: `fast-xml-parser` moved to `@1c-odata/metadata`, which is now a dependency of the CLI. The public API (`1c-odata` binary, `@1c-odata/cli/codegen` exports) is unchanged; only unsupported deep imports of internal parser/analysis modules would need updating.
