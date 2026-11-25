---
"@1c-odata/client": minor
---

Register virtual-table methods (`client.register(…).balance()` / `turnovers()` / `balanceAndTurnovers()` / `sliceFirst()` / `sliceLast()` / `drCrTurnovers()` / `extDimensions()` / `recordsWithExtDimensions()`) page and sort on the 1С server: `ReadFiOptions` gains `skip` (`$skip`) and `orderBy` (`$orderby`, `[{ field, dir? }]`), and passing `count: true` (`ReadFiCountOptions`) makes the method resolve to a `ReadFiPage` — `{ value, count }` — instead of the bare row array. Calls without `count` are unchanged and still resolve to `R[]`.

The count is a second request, the table's `…/Func()/$count` with the same parameters and `$filter`, sent in parallel with the page — not `$inlinecount`, which the 1С documentation says makes `$skip` / `$top` ignored. If either request fails, the call fails. The two requests see the data a moment apart, so on data changing meanwhile the count and the page can briefly disagree. 1С computes the whole virtual table for each request, so a page of a big table still costs that time — but only the page travels.

An untyped caller passing a negative or fractional `skip`, an `orderBy` that is not an array of `{ field, dir? }` (a blank field, a field with a space or a comma, or a `dir` other than `asc` / `desc` included) or a non-boolean `count` gets an `InvalidArgumentError` before any request.
