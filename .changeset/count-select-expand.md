---
"@1c-odata/client": patch
"@1c-odata/mcp": patch
---

`V3QueryBuilder.count()` now sends the query's `$select` and `$expand` to `/$count` along with `$filter`. 1С counts the rows as it would roll them up by that `$select`: on a register virtual table in the path (`client.query('AccumulationRegister_X/Balance').select(…)`), where 1С does roll the rows up, the count now matches them — before, it left `$select` out and could be thousands of times the rows (234859 against 105 on one БП 3.0 turnovers). Where 1С returns the rows un-rolled (seen on production УТ 11.x bases), the count is the rolled-up number and below the rows — as `register(…)` virtual-table calls with `count: true` already counted. On an ordinary entity set the number is the same. `$orderby` / `$top` / `$skip` stay off the count, as before. A `$select` 1С rejects now fails `count()` as it fails `get()` (HTTP 400) — a navigation path in it needs its `expand()`, on the count as on the page — where before the count ignored it.

The MCP `query` tool's `count` follows, and counts as `register_query` does; their descriptions now say that on a virtual table with `select` the count may be below the rows, to be paged while `hasMore` holds rather than by the count.
