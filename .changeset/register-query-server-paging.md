---
"@1c-odata/mcp": minor
---

**Breaking:** MCP `register_query` pages on the 1С server: each call reads one page (`$skip` / `$top`) and the exact row count (`$inlinecount`) instead of fetching up to 100 001 rows and slicing the page out of them. `total` is now exact however large the result — the `totalCapped` field, its "capped at N rows" summary note and the `ONEC_MCP_MAX_REGISTER_ROWS` environment variable are removed. Migration: drop `ONEC_MCP_MAX_REGISTER_ROWS` from the server's environment (it is ignored now) and stop reading `totalCapped`; `total` and `pagination.hasMore` carry the same meaning as before, without the cap. A page of a heavy table now costs about 15–20 s on 1С (measured on a БП 3.0 `AccountingRegister_Хозрасчетный/Turnovers()` of 235 000 rows) where every page used to cost about 24 s and 232 MB transferred; a small table answers in tens of milliseconds as before.

`register_query` also takes an optional `orderBy` (`[{ field, dir? }]`, the same shape as `query`'s): it sorts on the 1С server, so with `top` it returns a top-N — e.g. the ten largest debit turnovers. Sorting costs 1С time on a big table; without `orderBy` the rows keep 1С's own order, which stays the same from page to page.
