---
'@1c-odata/client': minor
---

The filter DSL refuses `undefined` as a value (#229), and the query builder sends no empty `$select` / `$expand` (#237).

- **`undefined` in a value slot is now an `InvalidArgumentError`** naming the field (`argument`, the row path inside `any()` / `all()`), and so is a function or a symbol (a method passed uncalled). It used to be written as a string — `f.X.eq(undefined)` sent `X eq 'undefined'`, `f.Сумма.add(undefined)` sent `(Сумма add 'undefined')` — a filter 1С rejects or silently matches nothing with.
- **`eq` / `ne` no longer accept `undefined` in their types** — for a hand-written `X: T | undefined`, a generated optional field (`X?: T | null`) and an untyped (`unknown`) field alike. A literal (`f.Code.eq('001')`) is unaffected; a value read from a row (`f.X.eq(row.X)`, where `row.X` may be missing) no longer compiles.

  **Migration:** check the value before the filter and pass it through a local constant — a narrowing of `row.X` does not reach into the callback: `const x = row.X; if (x !== undefined) q.filter((f) => f.X.eq(x))`. Or pass `null` where you mean a null field: `const x = row.X ?? null; q.filter((f) => f.X.eq(x))` on a field that admits `null`.
- **`select()` with no fields (or blank names only), or `expand()` while nothing is expanded, sends no `$select` / `$expand`** — in `get()`, `raw()`, `stream()` and `count()`; blank names beside real ones are dropped. It used to send `$select=` / `$expand=`, which 1С reads as absent (checked live: 200 with every property), so what comes back is unchanged — only the URL loses the empty option.
