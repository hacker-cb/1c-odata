---
'@1c-odata/client': patch
---

Filter DSL types: nullable fields get their operators, and `bigint` fields are typed as `bigint` (#230).

- **A nullable field has the operators of its type.** `FieldExprFor` distributed over the field's union with `null`, so a generated `Сумма?: number | null` had no `gt` / `add` / …, a `Дата?: Date | null` no `year()`, a `Комментарий?: string | null` no `startsWith` — `strictNullChecks` code needed a cast. The surface is now read off the non-null type as a whole.
- **`Edm.Int64` read as `bigint` (`int64Mode: 'bigint'`)**: comparisons and arithmetic take `bigint` operands, and `add` / `sub` / `mul` / `div` / `round` return a `bigint` expression (they were typed for `number`). `number` operands are still taken — `f.Int64.gt(5)`, `f.Int64.add(1).eq(5)` compile as before — and `eq` / `ne` on a `bigint` field take a `number` too. Code that annotated a `bigint` field's arithmetic as `ChainedFieldExpr<number>` needs `ChainedFieldExpr<bigint>`.
- **`any()` / `all()` take a nullable or optional tabular part** (`Товары?: Row[] | null`, as codegen emits it), which they refused in their types.

Nothing changes in what is sent.
