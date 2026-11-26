---
"@1c-odata/client": patch
"@1c-odata/mcp": patch
---

`V3QueryBuilder.count()` now sends the query's `$select` and `$expand` to `/$count` along with `$filter`, so it counts the rows `get()` of the same builder returns. On a register virtual table in the path (`client.query('AccumulationRegister_X/Balance').select(…)`) a `$select` may roll the rows up, and 1С counts them rolled: before, the count left `$select` out and could be several times the rows (1574 against 1416 on one УТ 11.5 balance, 32255 against 74 on one БП 3.0 turnovers). On an ordinary entity set the number is the same. `$orderby` / `$top` / `$skip` stay off the count, as before. A `$select` 1С rejects now fails `count()` as it fails `get()` (HTTP 400) — a navigation path in it needs its `expand()`, on the count as on the page — where before the count ignored it. The MCP `query` tool's `count` follows: for a virtual-table path with `select` it is now the number of rows the pages hold.
