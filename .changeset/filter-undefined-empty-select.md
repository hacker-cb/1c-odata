---
'@1c-odata/client': patch
---

The filter DSL refuses `undefined` as a value (#229), and the query builder sends no empty `$select` / `$expand` (#237).

- **`undefined` in a value slot is now an `InvalidArgumentError`** naming the field (`argument`, the row path inside `any()` / `all()`). It used to be written as the string `'undefined'` — `f.X.eq(undefined)` sent `X eq 'undefined'`, `f.Сумма.add(undefined)` sent `(Сумма add 'undefined')` — a filter 1С rejects or silently matches nothing with. The types never allowed it; untyped code (a missing variable, a property absent from a row) reached it. Compare with `null` for an empty value.
- **`select()` with no fields, or `expand()` with none, sends no `$select` / `$expand`** — in `get()`, `raw()`, `stream()` and `count()`. It used to send `$select=` / `$expand=`; 1С reads those as absent (checked live: 200 with every property), so what comes back is unchanged — only the URL loses the empty option.
