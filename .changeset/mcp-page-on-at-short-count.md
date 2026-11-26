---
"@1c-odata/mcp": patch
---

MCP `query` and `register_query` no longer end the paging on a full page that lands exactly on 1С's count. On a register virtual table with `select`, production УТ 11.x bases count the rows rolled up by the `select` and return them un-rolled, so the count is below the rows (seen on `AccumulationRegister_ТоварыНаСкладах` balance: a count of 921 with full pages still coming at `skip` 900; with `select: ["ВНаличииBalance"]` a count of 1). A full page with `skip + top` equal to that count answered `hasMore: false`, and a client paging by `hasMore` silently lost the rows past it. Now a full page always answers `hasMore: true`; a short or empty page ends the paging as before. The price is one empty page where the rows really end on a page boundary.
