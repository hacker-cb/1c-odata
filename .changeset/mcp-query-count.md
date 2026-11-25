---
"@1c-odata/mcp": patch
"@1c-odata/client": patch
---

MCP `query` with `count: true` no longer sends `$inlinecount`. By the 1С 8.3.27 documentation `$inlinecount` makes 1С drop `$skip` / `$top`, so on a publication that behaves as documented `query` with `count` and `skip` would silently return the start of the collection as the page asked for. The tool now reads the page alone and the exact total from the set's `/$count` (same `$filter`) in a parallel request — as `register_query` does — and a failure of either fails the call and aborts the other. A page 1С sends past `top` (a publication ignoring `$top`) is cut back to `top`, and the summary says so. The client's `withCount()` is unchanged; its JSDoc now names the documented caveat and the `.count()` alternative.
