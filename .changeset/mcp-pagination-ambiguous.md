---
"@1c-odata/mcp": patch
---

MCP `query` and `register_query` now mark a page they cannot place with an optional `pagination.ambiguous` — before, only the summary text said so, and in `structuredContent` such a page read as an ordinary last one (the requested `skip`, the table's first rows, `hasMore: false`), so a client reading only the structured result could join duplicates to the pages before it. `"skipIgnoredOrCountShort"`: at a `skip`, 1С sent as many rows as it counted (or, ignoring `$top`, more) — it either ignored `$skip` or counts fewer rows than it has (a `select` on a register virtual table, counted rolled up). `"skipUnverified"` (`query` only): 1С ignored `$top` and no count was asked for, so whether it kept to `$skip` is unknown. The field is present only on such a page, which ends the paging (`hasMore: false`); every other response is unchanged. The tool descriptions and the README describe it.
