import { InvalidArgumentError } from './errors.js'
import type { ChainedFieldExpr, FieldExpr, FieldExprMap, FilterExpression } from './query/filter-internal.js'
import {
  asCondition,
  lambdaContext,
  makeFieldProxy,
  makeFilter,
  makeGuidLiteral,
  rowSchemaOf,
} from './query/filter-internal.js'
import type { Guid } from './types/core.js'

// OData V3 precedence: `not > and > or`. `or` is loosest, so an `or`-joined
// sub-expression must be parenthesized when it's an `and` operand — otherwise
// `and(or(a, b), c)` would parse as `a or (b and c)`. Heuristic: parenthesize
// when the operand expression contains a top-level ` or ` (sub-expressions in
// parens or quotes don't trigger because their `or` is shielded by the wrap).
function needsAndWrap(expr: string): boolean {
  let depthParen = 0
  let inQuote = false
  for (let i = 0; i < expr.length - 3; i++) {
    const ch = expr[i]
    if (ch === "'") {
      // OData escapes quotes by doubling: `''` inside a literal stays in-quote.
      if (inQuote && expr[i + 1] === "'") {
        i++
        continue
      }
      inQuote = !inQuote
      continue
    }
    if (inQuote) continue
    if (ch === '(') depthParen++
    else if (ch === ')') depthParen--
    else if (depthParen === 0 && ch === ' ' && expr.startsWith(' or ', i)) return true
  }
  return false
}

/**
 * A nullable / optional collection field for `any()` / `all()`: one whose row
 * type is inferred. A field that holds no array at all (`null` only) infers
 * none and is refused here. This overload comes first, so the last one —
 * what `Parameters<typeof any>` reads — stays the plain `FieldExpr<V[]>`.
 */
type NullableCollection<V> = unknown extends V ? never : unknown

/** Variadic AND. @public */
export function and(...exprs: FilterExpression[]): FilterExpression {
  if (exprs.length === 0) throw new InvalidArgumentError('and() requires at least one expression')
  const ops = exprs.map((e, i) => asCondition(e, `and() operand ${i + 1}`))
  if (ops.length === 1) return ops[0] as FilterExpression
  return makeFilter(ops.map((e) => (needsAndWrap(e._expr) ? `(${e._expr})` : e._expr)).join(' and '))
}

/** Variadic OR. @public */
export function or(...exprs: FilterExpression[]): FilterExpression {
  if (exprs.length === 0) throw new InvalidArgumentError('or() requires at least one expression')
  const ops = exprs.map((e, i) => asCondition(e, `or() operand ${i + 1}`))
  if (ops.length === 1) return ops[0] as FilterExpression
  return makeFilter(ops.map((e) => `(${e._expr})`).join(' or '))
}

/** Negation. @public */
export function not(e: FilterExpression): FilterExpression {
  return makeFilter(`not (${asCondition(e, 'not() operand')._expr})`)
}

/** Lambda — at least one row matches. The collection may be typed nullable or optional (a generated tabular part). @public */
export function any<V>(
  field: FieldExpr<V[] | null | undefined> & NullableCollection<V>,
  fn: (t: FieldExprMap<V>) => FilterExpression,
): FilterExpression
export function any<V>(field: FieldExpr<V[]>, fn: (t: FieldExprMap<V>) => FilterExpression): FilterExpression
export function any<V>(
  field: FieldExpr<V[] | null | undefined>,
  fn: (t: FieldExprMap<V>) => FilterExpression,
): FilterExpression {
  const { ctx, expr } = lambdaContext(field, 'any() collection')
  const id = `t${ctx.lambdaCounter.value++}`
  const inner = makeFieldProxy<V>(`${id}/`, ctx, rowSchemaOf(field, ctx))
  const body = asCondition(fn(inner), 'any() lambda result')
  return makeFilter(`${expr}/any(${id}: ${body._expr})`)
}

/** Lambda — all rows match. The collection may be typed nullable or optional (a generated tabular part). @public */
export function all<V>(
  field: FieldExpr<V[] | null | undefined> & NullableCollection<V>,
  fn: (t: FieldExprMap<V>) => FilterExpression,
): FilterExpression
export function all<V>(field: FieldExpr<V[]>, fn: (t: FieldExprMap<V>) => FilterExpression): FilterExpression
export function all<V>(
  field: FieldExpr<V[] | null | undefined>,
  fn: (t: FieldExprMap<V>) => FilterExpression,
): FilterExpression {
  const { ctx, expr } = lambdaContext(field, 'all() collection')
  const id = `t${ctx.lambdaCounter.value++}`
  const inner = makeFieldProxy<V>(`${id}/`, ctx, rowSchemaOf(field, ctx))
  const body = asCondition(fn(inner), 'all() lambda result')
  return makeFilter(`${expr}/all(${id}: ${body._expr})`)
}

/**
 * A GUID literal — `guid'…'` — to compare a field with. A comparison on a
 * field the DSL knows holds a GUID writes a GUID string so by itself: an
 * `Edm.Guid` field of the query's schema (a `MetadataIndex`), or, for a field
 * the schema does not list or with no schema at all, a 1С reference named
 * `*_Key` (`Ref_Key`, `Контрагент_Key`). `guid()` is for the rest — an
 * `Edm.Guid` attribute queried without a schema, through a navigation path,
 * or on a virtual table (`Register_X/SliceLast()`). 1С matches no rows for a
 * GUID written as a plain string `'…'` against a reference, and fails the
 * request against another `Edm.Guid` field. It is a value for a comparison
 * (`eq` / `ne` / `gt` / `ge` / `lt` / `le`) only: as the operand of a string,
 * date or arithmetic function, or against a field the schema types other than
 * `Edm.Guid`, it is an `InvalidArgumentError`.
 *
 * @example
 *   client
 *     .query<{ Идентификатор: string }>('InformationRegister_ОбработчикиОбновления')
 *     .filter((f) => f.Идентификатор.eq(guid(id)))
 *
 * @throws InvalidArgumentError — `value` is not a GUID in the 8-4-4-4-12 hex form.
 * @public
 */
export function guid(value: string): FieldExpr<Guid> {
  return makeGuidLiteral(value)
}

/** Escape hatch — caller assembles the expression string. @public */
export function raw(s: string): FilterExpression {
  return makeFilter(s)
}

/**
 * Extract the OData V3 wire string from a `FilterExpression`. Use this when
 * logging filter values or assembling URLs manually outside the query builder.
 *
 * @example
 *   // Most common case — inspect what a `query.filter(f => ...)` produces:
 *   const q = client.query<X>('X').filter((f) => f.Code.eq('001'))
 *   toFilterString(q.state.filter!)  // "Code eq '001'"
 *
 *   // Or compose via `raw` / `and` directly:
 *   const f = and(raw("Code eq '001'"), raw('Sum gt 100'))
 *   toFilterString(f)  // "Code eq '001' and Sum gt 100"
 *
 * @public
 */
export function toFilterString(f: FilterExpression): string {
  return (f as unknown as { _expr: string })._expr
}

export type { ChainedFieldExpr, FieldExpr, FieldExprMap, FilterExpression }
