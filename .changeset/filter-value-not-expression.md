---
"@1c-odata/client": patch
---

The filter DSL no longer writes an arbitrary object with an `_expr` field into `$filter` as an OData expression. A comparison value or operator argument (`eq`, `gt`, `add`, `concat`, …) is taken as an expression only where this copy of the DSL itself built it — a field (`f.A.eq(f.B)`), a field expression, or what `raw()`, `and`, `or`, `not`, `any` and `all` return. Any other object carrying `_expr` — say, parsed from outside JSON and passed through untyped code — is now refused with an `InvalidArgumentError` (`argument` the field, `received` the value) instead of rewriting the filter's condition. Typed code passing the DSL's own expressions is unaffected; what is refused besides forged objects is a wrapper around a DSL expression (a `Proxy`, a spread copy) and an expression built by another installed copy of `@1c-odata/client`.
