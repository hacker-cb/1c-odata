---
'@1c-odata/client': minor
---

A collection response without a `value` array is a `ParseError`, not an empty result (#255).

`query().get()` / `stream()`, the register virtual tables (`balance()`, `turnovers()`, `sliceLast()`, …) and read functions through `client.functions` read a 200 body with no `value` array — a gateway's `{"error": …}`, a truncated or foreign body — as "no rows". They now fail with a `ParseError` naming what came instead: the first keys of the body (`got no "value" — keys "error"`), or the kind of `value` it held — never the body's values. A row of `value` that is not an object (`null`, a number) is a `ParseError` too, where `null` failed with a `TypeError` and a number read as an empty row.

1С sends every collection with `value`, an empty one as `"value": []` (checked on entity sets and on every register virtual table of both test bases), so nothing changes for a response from 1С itself.

**Migration:** none, unless code relied on such a body reading as empty — catch `ParseError` there.
