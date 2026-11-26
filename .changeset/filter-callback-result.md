---
'@1c-odata/client': patch
---

`filter()` refuses a callback result that is not a filter expression built by the DSL with an `InvalidArgumentError`, and leaves a filter set before as it was. Untyped code returning `undefined` (`.filter((f) => build?.(f))` with `build` missing) used to clear the query's filter — the request then went out over the whole entity set, silently. Typed code cannot return anything else: the callback is typed `(f) => FilterExpression`.
