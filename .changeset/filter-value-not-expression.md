---
"@1c-odata/client": minor
---

The filter DSL no longer writes an arbitrary object with an `_expr` field into `$filter` as an OData expression. A comparison value or operator argument (`eq`, `gt`, `add`, `concat`, …) is taken as an expression only where this copy of the DSL itself built it — a field (`f.A.eq(f.B)`), a field expression, or what `raw()`, `and`, `or`, `not`, `any` and `all` return. Any other object carrying `_expr` — say, parsed from outside JSON and passed through untyped code — is now refused with an `InvalidArgumentError` (`argument` the field, `received` the value) instead of rewriting the filter's condition.

DSL expressions built by another installed copy of `@1c-odata/client` — and a `Proxy` or a spread copy over a DSL expression — are now refused the same way (`InvalidArgumentError`) where they used to be written as expressions. Migration: build the filter with the same copy of the package that runs the query — keep one version of `@1c-odata/client` in the dependency tree (`pnpm why @1c-odata/client` shows the copies).
