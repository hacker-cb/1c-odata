---
"@1c-odata/client": patch
"@1c-odata/mcp": patch
---

Function-import and register virtual-table URLs now encode the entity-set and function names as single path segments, as the collection URLs already did: a name carrying `/`, `?`, `#` or `..` — e.g. a `register` argument passed to MCP `register_query` — can no longer reach another path of the host with the connection's credentials or push `$top` into a URL fragment; a name that is empty, `.` or `..` is rejected with `InvalidArgumentError`. Cyrillic names are percent-encoded on the wire as before. MCP `register_query` also stops reporting `hasMore: true` past the row cap: paging ends at the last fetched row, and the cap is still reported by `totalCapped` and the summary note.
