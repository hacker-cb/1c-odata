---
'@1c-odata/client': patch
---

`filter()` refuses a callback result that is not a filter expression with an `InvalidArgumentError`, and leaves a filter set before as it was. Untyped code returning `undefined` (`.filter((f) => build?.(f))` with `build` missing) used to clear the query's filter — the request then went out over the whole entity set, silently; `null`, a string or an object without `_expr` text are refused too, and so is a `guid()` literal (a value, not a condition). The combinators `and` / `or` / `not` / `any` / `all` refuse such an operand with the same error instead of a `TypeError`. Typed code is unaffected: the callback is typed `(f) => FilterExpression`, and any filter expression — a copy of one included — is taken as before. To query without a filter, build a new query.
