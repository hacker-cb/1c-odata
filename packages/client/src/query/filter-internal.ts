// packages/client/src/query/filter-internal.ts
import { formatInZone } from '../timezone.js'

declare const filterExpressionBrand: unique symbol
declare const fieldExprBrand: unique symbol

/**
 * Compiled filter expression. Public surface is the nominal brand — use
 * `toFilterString(f)` from `@1c-odata/client` to extract the OData V3 wire
 * string. The internal wire field is an implementation detail.
 *
 * The brand field is structurally inaccessible to consumers (private
 * unique-symbol key), so plain objects cannot satisfy this interface — only
 * values produced by the filter DSL (`and`, `or`, `not`, `raw`, `any`, `all`,
 * or field-expression method calls) qualify.
 *
 * @public
 */
export interface FilterExpression {
  readonly [filterExpressionBrand]: never
  /** @internal */
  readonly _expr: string
}

/**
 * Compiled field-or-function sub-expression. Like `FilterExpression`, the
 * public surface is a nominal brand — plain objects cannot satisfy this
 * interface, so callers of `eq(v: V | FieldExpr<V>)` etc. can only pass
 * values produced by the DSL proxy (`f.<Field>`, lambda parameters in
 * `any()`/`all()`, or compose-style method results).
 *
 * The brand carries `V` so the generic parameter remains tracked after
 * `_phantom` is stripped from the public `.d.ts`.
 *
 * @public
 */
export interface FieldExpr<V> {
  readonly [fieldExprBrand]: V
  /** @internal */
  readonly _expr: string
  /** @internal */
  readonly _phantom?: V
}

/** @internal — internal field expression with attached compile context. */
export interface InternalFieldExpr<V> extends FieldExpr<V> {
  readonly _ctx: CompileContext
}

/** @internal — per-compileFilter mutable state (timezone + lambda counter). */
export interface CompileContext {
  readonly serverTimezone: string
  /** Mutable lambda counter — incremented per `any()`/`all()` use. */
  lambdaCounter: { value: number }
}

function makeFilter(expr: string): FilterExpression {
  return Object.freeze({ _expr: expr }) as unknown as FilterExpression
}

function formatLiteral(v: unknown, ctx: CompileContext): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'bigint') return String(v)
  if (v instanceof Date) return `datetime'${formatInZone(v, ctx.serverTimezone)}'`
  if (typeof v === 'object' && v !== null && '_expr' in (v as object)) {
    return (v as { _expr: string })._expr
  }
  return `'${String(v).replace(/'/g, "''")}'`
}

/**
 * Map of typed field-expression proxies for entity `T`. Property access yields
 * a `FieldExpr<V>` whose method surface is narrowed by `V` via `FieldExprFor`.
 *
 * @public
 */
export type FieldExprMap<T> = { [K in keyof T]-?: FieldExprFor<T[K]> }

/**
 * Type-level operator surface for a field of value type `V`. Uses conditional
 * intersections so e.g. `string` exposes `startsWith` while `number` exposes
 * `add`/`gt` and so on. Always includes `BaseOps<V>` (eq/ne).
 *
 * @public
 */
export type FieldExprFor<V> = BaseOps<V> &
  (V extends string ? StringOps : object) &
  (V extends number | bigint ? NumberOps : object) &
  (V extends Date ? DateOps : object) &
  (V extends boolean ? BooleanOps : object) &
  (V extends string ? RefOps : object)

interface BaseOps<V> {
  eq(v: V | FieldExpr<V>): FilterExpression
  ne(v: V | FieldExpr<V>): FilterExpression
}

interface NumberOps {
  gt(v: number | FieldExpr<number>): FilterExpression
  ge(v: number | FieldExpr<number>): FilterExpression
  lt(v: number | FieldExpr<number>): FilterExpression
  le(v: number | FieldExpr<number>): FilterExpression
  add(v: number | FieldExpr<number>): FieldExpr<number>
  sub(v: number | FieldExpr<number>): FieldExpr<number>
  mul(v: number | FieldExpr<number>): FieldExpr<number>
  div(v: number | FieldExpr<number>): FieldExpr<number>
  round(): FieldExpr<number>
}

interface StringOps {
  gt(v: string): FilterExpression
  ge(v: string): FilterExpression
  lt(v: string): FilterExpression
  le(v: string): FilterExpression
  startsWith(v: string): FilterExpression
  endsWith(v: string): FilterExpression
  substringof(v: string): FilterExpression
  like(pattern: string): FilterExpression
  concat(other: string | FieldExpr<string>): FieldExpr<string>
  substring(start: number, length?: number): FieldExpr<string>
}

interface DateOps {
  gt(v: Date | FieldExpr<Date>): FilterExpression
  ge(v: Date | FieldExpr<Date>): FilterExpression
  lt(v: Date | FieldExpr<Date>): FilterExpression
  le(v: Date | FieldExpr<Date>): FilterExpression
  year(): FieldExpr<number>
  month(): FieldExpr<number>
  day(): FieldExpr<number>
  hour(): FieldExpr<number>
  minute(): FieldExpr<number>
  second(): FieldExpr<number>
  dayofweek(): FieldExpr<number>
  dayofyear(): FieldExpr<number>
  quarter(): FieldExpr<number>
  dateadd(unit: 'second' | 'minute' | 'hour' | 'day' | 'month' | 'quarter' | 'year', amount: number): FieldExpr<Date>
  datedifference(
    other: Date | FieldExpr<Date>,
    unit: 'second' | 'minute' | 'hour' | 'day' | 'month' | 'quarter' | 'year',
  ): FieldExpr<number>
}

// biome-ignore lint/suspicious/noEmptyInterface: BaseOps eq/ne suffice
interface BooleanOps {}

/**
 * OData `isof` / `cast` operators on composite-typed string fields — the
 * canonical use case is the GUID-string half of a polymorphic-ref pair
 * (`<X>` + `<X>_Type`).
 *
 * Polymorphic-ref fields are typed as plain `string` (matching the EDMX wire
 * shape), so `FieldExprFor<V>` admits these operators on every `string` field
 * — the type system can't distinguish composite-typed strings from ordinary
 * ones. Calling `isof`/`cast` on a non-composite string is a server-side
 * error; caller responsibility.
 *
 * `cast()` here is typed `FieldExpr<string>` because polymorphic-ref pairs
 * are the only composite kind we surface as `string`. The 1С platform also
 * accepts `cast`/`isof` on other composite-typed attrs (e.g. composite-
 * numeric requisites) — those aren't reachable through this typed surface;
 * fall back to `raw(...)` if you need them.
 */
interface RefOps {
  isof(typeName: string): FilterExpression
  cast(typeName: string): FieldExpr<string>
}

/**
 * Build a FieldExpr-typed proxy. Every property access returns a wrapped
 * field expression with all method surfaces; TS narrowing via FieldExprFor<V>
 * controls which methods are visible at the type level.
 *
 * @internal
 */
export function makeFieldProxy<T>(prefix: string, ctx: CompileContext): FieldExprMap<T> {
  return new Proxy({} as FieldExprMap<T>, {
    get(_, key) {
      if (typeof key !== 'string') return undefined
      if (key === '_expr' || key === '_phantom' || key === '_ctx') return undefined
      return wrapField<unknown>(prefix + key, ctx)
    },
  })
}

function wrapField<V>(expr: string, ctx: CompileContext): FieldExprFor<V> & FieldExpr<V> & { _ctx: CompileContext } {
  const f = {
    _expr: expr,
    _ctx: ctx,
    eq: (v: unknown) => makeFilter(`${expr} eq ${formatLiteral(v, ctx)}`),
    ne: (v: unknown) => makeFilter(`${expr} ne ${formatLiteral(v, ctx)}`),
    gt: (v: unknown) => makeFilter(`${expr} gt ${formatLiteral(v, ctx)}`),
    ge: (v: unknown) => makeFilter(`${expr} ge ${formatLiteral(v, ctx)}`),
    lt: (v: unknown) => makeFilter(`${expr} lt ${formatLiteral(v, ctx)}`),
    le: (v: unknown) => makeFilter(`${expr} le ${formatLiteral(v, ctx)}`),
    startsWith: (v: string) => makeFilter(`startswith(${expr}, ${formatLiteral(v, ctx)})`),
    endsWith: (v: string) => makeFilter(`endswith(${expr}, ${formatLiteral(v, ctx)})`),
    substringof: (v: string) => makeFilter(`substringof(${formatLiteral(v, ctx)}, ${expr})`),
    like: (pat: string) => makeFilter(`like(${expr}, ${formatLiteral(pat, ctx)})`),
    concat: (other: unknown) => wrapField<string>(`concat(${expr}, ${formatLiteral(other, ctx)})`, ctx),
    substring: (start: number, length?: number) =>
      wrapField<string>(
        length !== undefined ? `substring(${expr}, ${start}, ${length})` : `substring(${expr}, ${start})`,
        ctx,
      ),
    add: (v: unknown) => wrapField<number>(`${expr} add ${formatLiteral(v, ctx)}`, ctx),
    sub: (v: unknown) => wrapField<number>(`${expr} sub ${formatLiteral(v, ctx)}`, ctx),
    mul: (v: unknown) => wrapField<number>(`${expr} mul ${formatLiteral(v, ctx)}`, ctx),
    div: (v: unknown) => wrapField<number>(`${expr} div ${formatLiteral(v, ctx)}`, ctx),
    round: () => wrapField<number>(`round(${expr})`, ctx),
    year: () => wrapField<number>(`year(${expr})`, ctx),
    month: () => wrapField<number>(`month(${expr})`, ctx),
    day: () => wrapField<number>(`day(${expr})`, ctx),
    hour: () => wrapField<number>(`hour(${expr})`, ctx),
    minute: () => wrapField<number>(`minute(${expr})`, ctx),
    second: () => wrapField<number>(`second(${expr})`, ctx),
    dayofweek: () => wrapField<number>(`dayofweek(${expr})`, ctx),
    dayofyear: () => wrapField<number>(`dayofyear(${expr})`, ctx),
    quarter: () => wrapField<number>(`quarter(${expr})`, ctx),
    dateadd: (unit: string, amount: number) => wrapField<Date>(`dateadd(${expr}, '${unit}', ${amount})`, ctx),
    datedifference: (other: unknown, unit: string) =>
      wrapField<number>(`datedifference(${expr}, ${formatLiteral(other, ctx)}, '${unit}')`, ctx),
    isof: (typeName: string) => makeFilter(`isof(${expr}, ${formatLiteral(typeName, ctx)})`),
    cast: (typeName: string) => wrapField<string>(`cast(${expr}, ${formatLiteral(typeName, ctx)})`, ctx),
  }
  return f as unknown as FieldExprFor<V> & FieldExpr<V> & { _ctx: CompileContext }
}

/**
 * Compile a filter callback into its OData V3 string. Used by V3QueryBuilder
 * and tests.
 *
 * @internal
 */
export function compileFilter<T>(serverTimezone: string, fn: (f: FieldExprMap<T>) => FilterExpression): string {
  const ctx: CompileContext = { serverTimezone, lambdaCounter: { value: 0 } }
  const f = makeFieldProxy<T>('', ctx)
  return fn(f)._expr
}
