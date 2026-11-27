---
'@1c-odata/mcp': patch
---

`describe_entity` looks names up by the client's own-key rule, the one the read and write paths use. An entity set resolves only where the index holds its type's schema — as the client sees it when it reads or writes that set; a set naming a type the index lacks (an index `buildMetadataIndex` never builds, and `parseMetadataIndex` refuses) answers `Unknown entity` instead of a description with no properties.
