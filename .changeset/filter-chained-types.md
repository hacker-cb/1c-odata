---
"@1c-odata/client": minor
---

Filter DSL chaining is now correctly typed. Methods that return an expression (`f.Date.year()`, `f.Сумма.add(5)`, `concat`, `substring`, `cast`, `dateadd`, …) previously returned the bare branded `FieldExpr<V>` with no operator surface, so chains like `f.Date.year().eq(2025)` — the README example — failed to compile against the public types (the runtime Proxy always worked). They now return the new `ChainedFieldExpr<V>` (brand + operators), and `FieldExprMap` property access carries the brand, so field proxies type-check as arguments to `any`/`all` and operator parameters.
