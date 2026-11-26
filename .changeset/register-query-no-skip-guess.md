---
"@1c-odata/mcp": patch
---

`register_query` no longer drops rows on a guess. Where 1С ignores `$top` and sends, at a `skip`, exactly as many rows as it counted, the tool took them for the whole table (`$skip` ignored too) and returned the rows from `skip` on — but a count short of the rows (a `select` 1С counts rolled up and returns un-rolled) looks the same, and then the rows asked for were dropped. Such a page is now cut to `top` from its start, as `query` does: `hasMore` is `false` (the byte budget included) and the summary names both readings. An empty page now ends the paging too (`hasMore: false`) even where the parallel `/$count` reported more rows — before, it reported `hasMore: true` and a client paging by `returned` asked for the same page again. The response shape is unchanged.
