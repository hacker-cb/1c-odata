---
"@1c-odata/client": minor
"@1c-odata/cli": minor
---

**Reject `NaN` / `Infinity` in numeric literals (silent data loss fix).**

`$filter` numeric operators (`eq`, `gt`, `add`, etc.) and `FunctionImport` argument
serialization previously formatted `NaN` / `+Infinity` / `-Infinity` as the bare
strings `NaN` / `Infinity` / `-Infinity`. None of these are valid OData V3 literals
— 1С either rejected them with HTTP 400 or (in the worst case) returned spurious
results as if the comparison had been dropped.

These three values now throw `InvalidArgumentError` synchronously when constructing
the query, with `argument` pointing at the offending field name or FI parameter.

**Migration:**
- Code paths that always pass finite numbers are unaffected.
- Callers that derive numeric inputs from reductions over potentially-empty arrays
  (e.g. `Math.max(...arr)` → `-Infinity` when `arr === []`) must guard before
  passing the value to the DSL.

**Also removes `mapResponseToError` from the public API.**

This helper was exported from `@1c-odata/client` but never listed in `STABILITY.md`.
It is now `@internal` — still used by the library's transport internally, but no
longer part of the documented surface. The 1С platform-specific error decision
tree (500+code"-1" → `BusinessError`, 401 → `PermissionError`, 412 →
`ConcurrencyError`, etc.) is still applied automatically to every request; consumers
catch the resulting typed `ODataError` subclass as before.

If you imported `mapResponseToError` directly, replace it with a `try { ... } catch (e) { if (e instanceof BusinessError) ... }` flow at the call site.
