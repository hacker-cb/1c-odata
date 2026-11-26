---
'@1c-odata/client': minor
---

Filter DSL types: nullable fields get their operators, and `bigint` fields are typed as `bigint` (#230).

- **A nullable field has the operators of its type.** `FieldExprFor` distributed over the field's union with `null`, so a generated `Сумма?: number | null` had no `gt` / `add` / …, a `Дата?: Date | null` no `year()`, a `Комментарий?: string | null` no `startsWith` — `strictNullChecks` code needed a cast. The surface is now read off the non-null type as a whole. A nullable field is an operand too (`f.Количество.gt(f.Сумма)`, `f.Дата.lt(f.ДатаОкончания)`), and arithmetic on it keeps its `null` (`f.Сумма.add(1)` is a `number | null` expression, so `.eq(null)` compiles).
- **Numeric fields are one family.** An `Edm.Int64` read as `bigint` (`int64Mode: 'bigint'`): comparisons and arithmetic take `number` or `bigint` operands, and `add` / `sub` / `mul` / `div` / `round` return a `bigint` expression (they were typed for `number`). A `number` field takes a `bigint` or a `bigint` expression as well, and a field typed `number | bigint` keeps its operators. `f.Int64.gt(5)` and `f.Int64.add(1).eq(5)` compile as before.
- **`any()` / `all()` take a nullable or optional tabular part** (`Товары?: Row[] | null`, as codegen emits it), which they refused in their types; a field holding no array at all is still refused.

Nothing changes in what is sent.

**Migration:** code that annotated a `bigint` field's arithmetic as `ChainedFieldExpr<number>` needs `ChainedFieldExpr<bigint>` (or no annotation).
