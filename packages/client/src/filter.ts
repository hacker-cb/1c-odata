import { InvalidArgumentError } from './errors.js'
import type { FieldExpr, FieldExprMap, FilterExpression } from './query/filter-internal.js'
import { type CompileContext, makeFieldProxy } from './query/filter-internal.js'

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

/** Variadic AND. @public */
export function and(...exprs: FilterExpression[]): FilterExpression {
  if (exprs.length === 0) throw new InvalidArgumentError('and() requires at least one expression')
  if (exprs.length === 1) return exprs[0] as FilterExpression
  return Object.freeze({
    _expr: exprs.map((e) => (needsAndWrap(e._expr) ? `(${e._expr})` : e._expr)).join(' and '),
  }) as unknown as FilterExpression
}

/** Variadic OR. @public */
export function or(...exprs: FilterExpression[]): FilterExpression {
  if (exprs.length === 0) throw new InvalidArgumentError('or() requires at least one expression')
  if (exprs.length === 1) return exprs[0] as FilterExpression
  return Object.freeze({ _expr: exprs.map((e) => `(${e._expr})`).join(' or ') }) as unknown as FilterExpression
}

/** Negation. @public */
export function not(e: FilterExpression): FilterExpression {
  return Object.freeze({ _expr: `not (${e._expr})` }) as unknown as FilterExpression
}

/** Lambda — at least one row matches. @public */
export function any<V>(field: FieldExpr<V[]>, fn: (t: FieldExprMap<V>) => FilterExpression): FilterExpression {
  const ctx = (field as unknown as { _ctx: CompileContext })._ctx
  const id = `t${ctx.lambdaCounter.value++}`
  const inner = makeFieldProxy<V>(`${id}/`, ctx)
  const body = fn(inner)
  return Object.freeze({ _expr: `${field._expr}/any(${id}: ${body._expr})` }) as unknown as FilterExpression
}

/** Lambda — all rows match. @public */
export function all<V>(field: FieldExpr<V[]>, fn: (t: FieldExprMap<V>) => FilterExpression): FilterExpression {
  const ctx = (field as unknown as { _ctx: CompileContext })._ctx
  const id = `t${ctx.lambdaCounter.value++}`
  const inner = makeFieldProxy<V>(`${id}/`, ctx)
  const body = fn(inner)
  return Object.freeze({ _expr: `${field._expr}/all(${id}: ${body._expr})` }) as unknown as FilterExpression
}

/** Escape hatch — caller assembles the expression string. @public */
export function raw(s: string): FilterExpression {
  return Object.freeze({ _expr: s }) as unknown as FilterExpression
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

export type { FieldExpr, FieldExprMap, FilterExpression }
