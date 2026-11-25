---
"@1c-odata/mcp": patch
"@1c-odata/client": patch
---

MCP `query` with `count: true` no longer sends `$inlinecount`. By the 1С 8.3.27 documentation `$inlinecount` makes 1С drop `$skip` / `$top`, so on a publication that behaves as documented `query` with `count` and `skip` would silently return the start of the collection as the page asked for. The tool now reads the page alone and the exact total from the set's `/$count` (same `$filter`) in a parallel request — as `register_query` does — and a failure of either fails the call and aborts the other. The page never holds more than `top` rows: one 1С sends past `top` (a publication ignoring `$top`) is cut back to `top`. A page that cannot be placed — past `top` without `count`, or at a `skip` with exactly as many rows as 1С counted (it ignored `$skip`, or counts short) — offers no paging on (`hasMore: false`), and the summary says why. An empty page always ends the paging, whatever the count says. The client's `withCount()` is unchanged; its JSDoc now names the documented caveat and the `.count()` alternative.
