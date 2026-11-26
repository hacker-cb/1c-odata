---
'@1c-odata/client': minor
---

The filter DSL refuses `undefined` as a value (#229), and the query builder sends no empty `$select` / `$expand` (#237).

- **`undefined` in a value slot is now an `InvalidArgumentError`** naming the field (`argument`, the row path inside `any()` / `all()`), and so is a function or a symbol (a method passed uncalled). It used to be written as a string — `f.X.eq(undefined)` sent `X eq 'undefined'`, `f.Сумма.add(undefined)` sent `(Сумма add 'undefined')` — a filter 1С rejects or silently matches nothing with.
- **`eq` / `ne` no longer accept `undefined` in their types**: their parameter is `Exclude<V, undefined> | FieldExpr<V>`. A field generated as optional (`X?: T`) was never affected; a hand-written `X: T | undefined` is.

  **Migration:** for a field typed `X: string | undefined`, check the value before the filter (`if (row.X !== undefined) q.filter((f) => f.X.eq(row.X))`), or pass `null` explicitly where you mean a null field (`f.X.eq(row.X ?? null)` on a field that admits `null`).
- **`select()` with no fields (or blank names only), or `expand()` while nothing is expanded, sends no `$select` / `$expand`** — in `get()`, `raw()`, `stream()` and `count()`; blank names beside real ones are dropped. It used to send `$select=` / `$expand=`, which 1С reads as absent (checked live: 200 with every property), so what comes back is unchanged — only the URL loses the empty option.
