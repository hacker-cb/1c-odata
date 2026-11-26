// packages/client/src/query/filter-internal.ts
import { InvalidArgumentError, ODataError } from '../errors.js'
import { formatNumberLiteral } from '../format-number.js'
import type { Guid } from '../types/core.js'
import { formatScalarLiteral, GUID_RE } from '../url-builder.js'
import type { EntitySchema, MetadataIndex } from '../validate.js'

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

/** @internal — per-compileFilter mutable state (timezone + lambda counter + schema index). */
export interface CompileContext {
  readonly serverTimezone: string
  /** Mutable lambda counter — incremented per `any()`/`all()` use. */
  lambdaCounter: { value: number }
  /**
   * The index the filtered entity's schema came from, where the query has one:
   * `any()`/`all()` resolve a tabular part's row type through it.
   */
  readonly metadataIndex?: MetadataIndex | undefined
}

/**
 * The declared EDM type of each field expression the proxy built from a schema
 * property (`Edm.Guid`, `Collection(<ns>.<Row>)`, …). Kept beside the frozen
 * expression rather than on it, so no internal key shadows a 1С field name.
 */
const fieldTypes = new WeakMap<object, string>()

/**
 * Every expression the DSL itself built — filters and field expressions alike.
 * What tells an expression from a value: an `_expr` field proves nothing, since
 * any object parsed from JSON can carry one, but membership here cannot be
 * forged by data.
 */
const dslExpressions = new WeakSet<object>()

/**
 * Whether `v` is an expression the DSL built — a filter, or a field expression
 * (a boolean field stands as a filter by itself), but not a `guid()` literal.
 * What `filter()` takes from its callback.
 *
 * @internal
 */
export function isDslExpression(v: unknown): v is FilterExpression {
  // A `guid()` literal is a value, not a condition.
  return typeof v === 'object' && v !== null && dslExpressions.has(v) && !guidLiterals.has(v)
}

/** Register `expr` as built by the DSL and return it. */
function dslExpression<T extends object>(expr: T): T {
  dslExpressions.add(expr)
  return expr
}

/**
 * A frozen `FilterExpression` over the OData V3 string `expr`, registered as
 * built by the DSL.
 *
 * @internal
 */
export function makeFilter(expr: string): FilterExpression {
  const filter = dslExpression(Object.freeze({ _expr: expr }))
  dslFilters.add(filter)
  return filter as unknown as FilterExpression
}

/**
 * The filters among `dslExpressions` — what `makeFilter` built (comparisons,
 * `raw`, `and`/`or`/`not`, `any`/`all`), as against field expressions. Such
 * text carries its own operators, so where it lands in a value slot (untyped
 * code: the types take only field expressions there) it is written in
 * parentheses, keeping its grouping.
 */
const dslFilters = new WeakSet<object>()

/**
 * The OData literal of a comparison or operator argument: a scalar by its JS
 * type, or an expression the DSL built (a field as the value, `f.A.eq(f.B)`)
 * as its own text. Any other object with an `_expr` field is refused — taken
 * as an expression, a value from outside would rewrite the filter. `undefined`,
 * a function and a symbol are refused too — a missing variable or property, or
 * a method passed uncalled, not a value: `null` compares with a null field. Reading a value that is not the DSL's can fail
 * on its own (no prototype, a `toString` that is not a function, a revoked
 * `Proxy`): that is an `InvalidArgumentError` naming the field too, the
 * failure its `cause`.
 */
function formatLiteral(v: unknown, ctx: CompileContext, argument: string): string {
  if (v === null) return 'null'
  if (typeof v === 'object' && guidLiterals.has(v)) {
    throw new InvalidArgumentError(
      `guid() for "${argument}" is a value to compare a GUID field with (eq/ne/gt/ge/lt/le) — ` +
        'not an operand of a string, date or arithmetic function',
      { argument, received: (v as { _expr: string })._expr },
    )
  }
  // Not values: a missing variable or property, or a function / symbol passed
  // where its result was meant — written by `String(v)` they would reach 1С as text.
  if (v === undefined || typeof v === 'function' || typeof v === 'symbol') {
    throw new InvalidArgumentError(
      `Filter value for "${argument}" is ${v === undefined ? 'undefined' : `a ${typeof v}`}, not a value` +
        ' — pass null to compare with a null field',
      { argument, received: v },
    )
  }
  if (typeof v === 'object' && dslExpressions.has(v)) {
    const text = (v as { _expr: string })._expr
    return dslFilters.has(v) ? `(${text})` : text
  }
  try {
    const literal = formatScalarLiteral(v, ctx.serverTimezone, argument)
    if (literal !== undefined) return literal
    if (typeof v === 'object' && '_expr' in v) {
      throw new InvalidArgumentError(
        `Filter value for "${argument}" is an object with an "_expr" field that the filter DSL did not build — ` +
          'pass a scalar, or a field expression (f.<Field>) to compare with another field',
        { argument, received: v },
      )
    }
    return `'${String(v).replace(/'/g, "''")}'`
  } catch (cause) {
    if (cause instanceof ODataError) throw cause
    throw new InvalidArgumentError(`Filter value for "${argument}" cannot be read as a literal`, {
      argument,
      received: v,
      cause,
    })
  }
}

/**
 * What the field at `path` holds — on a GUID field comparisons write a
 * GUID string as `guid'…'`, which 1С needs: a quoted `'…'` against a reference
 * matches nothing, silently, and against another `Edm.Guid` field fails. The
 * schema decides where it has the field (`propType`); otherwise the 1С naming
 * rule does — a reference is `<X>_Key` (every `*_Key` property of the 1С bases
 * checked is `Edm.Guid`), read on the last segment of the path. A path through
 * a navigation property (`'Ответственный/Идентификатор'`) is not in the
 * entity's schema, so it too goes by the name.
 */
function guidKind(path: string, propType: string | undefined): GuidKind {
  if (propType !== undefined) return propType === 'Edm.Guid' ? 'guid' : 'other'
  // The suffix holds no '/': the last segment's is the path's.
  return path.endsWith('_Key') ? 'guid' : 'unknown'
}

/**
 * What a field is known to hold: a GUID (`Edm.Guid` by the schema, or a `*_Key`
 * name), something else by the schema, or — no schema for it, or a computed
 * expression — unknown.
 */
type GuidKind = 'guid' | 'other' | 'unknown'

/** The literals `guid()` built — values for a comparison only. */
const guidLiterals = new WeakSet<object>()

/**
 * The string inside `v`: a primitive string, or a `String` object of any realm
 * (read by `String.prototype.valueOf` itself, as `dateTime` reads a `Date`);
 * `undefined` for anything else.
 */
function stringValue(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (typeof v !== 'object' || v === null) return undefined
  try {
    return String.prototype.valueOf.call(v)
  } catch {
    return undefined
  }
}

/**
 * The operand of a comparison on a field: `guid()` is taken as is — unless the
 * schema says the field holds no GUID (an `Edm.String` such as `Recorder`,
 * which 1С fails to compare with one) — and on a GUID field a string, primitive
 * or boxed, goes through `formatGuidComparand`.
 */
function formatComparand(v: unknown, ctx: CompileContext, argument: string, kind: GuidKind): string {
  if (typeof v === 'object' && v !== null && guidLiterals.has(v)) {
    if (kind === 'other') {
      throw new InvalidArgumentError(
        `guid() for "${argument}": the schema types this field other than Edm.Guid — compare it with a string`,
        { argument, received: (v as { _expr: string })._expr },
      )
    }
    return (v as { _expr: string })._expr
  }
  return kind === 'guid' ? formatGuidComparand(v, ctx, argument) : formatLiteral(v, ctx, argument)
}

/**
 * The operand of a comparison on a GUID field: a string is written
 * `guid'…'`, and must have the GUID form — any other string is an
 * `InvalidArgumentError` rather than a filter 1С answers with no rows or a
 * 400. Anything else (`null`, a field expression, `guid()`) as `formatLiteral`
 * writes it.
 */
function formatGuidComparand(v: unknown, ctx: CompileContext, argument: string): string {
  const s = stringValue(v)
  if (s === undefined) return formatLiteral(v, ctx, argument)
  if (!GUID_RE.test(s)) {
    throw new InvalidArgumentError(
      `Filter value for "${argument}" must be a GUID (8-4-4-4-12 hex form): the field is an Edm.Guid ` +
        '(by the schema, or a 1С reference named *_Key)',
      { argument, received: v },
    )
  }
  return `guid'${s}'`
}

/**
 * A GUID literal for a filter value: `guid'…'`, as a field expression the DSL
 * built, so any comparison takes it as is. For a field the DSL cannot tell is
 * an `Edm.Guid` — one the schema does not list and not named `*_Key`
 * (`Идентификатор` queried schema-less, or through a navigation path).
 *
 * @throws InvalidArgumentError — `value` is not a GUID in the 8-4-4-4-12 hex form.
 * @internal
 */
export function makeGuidLiteral(value: string): FieldExpr<Guid> {
  if (typeof value !== 'string' || !GUID_RE.test(value)) {
    throw new InvalidArgumentError('guid() takes a GUID in the 8-4-4-4-12 hex form', {
      argument: 'guid',
      received: value,
    })
  }
  const literal = dslExpression(Object.freeze({ _expr: `guid'${value}'` }))
  guidLiterals.add(literal)
  return literal as unknown as FieldExpr<Guid>
}

/**
 * The row schema of a tabular part `field` — what `any()`/`all()` give their
 * lambda's fields — resolved from its declared `Collection(<ns>.<Row>)` type
 * through the context's index (as `parser.ts` resolves a nested value's type).
 * `undefined` without an index, for a field the proxy built with no schema, or
 * for a row type the index does not hold.
 *
 * @internal
 */
export function rowSchemaOf(field: object, ctx: CompileContext): EntitySchema | undefined {
  const index = ctx.metadataIndex
  let t = fieldTypes.get(field)
  if (index === undefined || t === undefined) return undefined
  if (t.startsWith('Collection(') && t.endsWith(')')) t = t.slice('Collection('.length, -1)
  const prefix = `${index.schemaNamespace}.`
  const local = t.startsWith(prefix) ? t.slice(prefix.length) : t
  return Object.hasOwn(index.schemas, local) ? index.schemas[local] : undefined
}

/**
 * A chainable field expression: the branded `FieldExpr<V>` PLUS the operator
 * surface for `V`. This is what every chaining DSL method returns (e.g.
 * `f.Date.year()`, `f.Сумма.add(5)`) and what `FieldExprMap` property access
 * yields — so chains keep their operators and any expression can be passed
 * where a branded `FieldExpr<V>` is expected (`any`/`all`, operator args).
 *
 * @public
 */
export type ChainedFieldExpr<V> = FieldExpr<V> & FieldExprFor<V>

/**
 * Map of typed field-expression proxies for entity `T`. Property access yields
 * a branded, chainable expression whose method surface is narrowed by the
 * field's value type via `FieldExprFor`.
 *
 * @public
 */
export type FieldExprMap<T> = { [K in keyof T]-?: ChainedFieldExpr<T[K]> }

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
  /**
   * `<field> eq <v>`. `null` compares with a null field; `undefined` is no
   * value — an `InvalidArgumentError` (check a value that may be missing, a
   * field left out of `$select`, before the filter).
   */
  eq(v: V | FieldExpr<V>): FilterExpression
  /**
   * `<field> ne <v>`. `null` compares with a null field; `undefined` is no
   * value — an `InvalidArgumentError`.
   */
  ne(v: V | FieldExpr<V>): FilterExpression
}

interface NumberOps {
  gt(v: number | FieldExpr<number>): FilterExpression
  ge(v: number | FieldExpr<number>): FilterExpression
  lt(v: number | FieldExpr<number>): FilterExpression
  le(v: number | FieldExpr<number>): FilterExpression
  add(v: number | FieldExpr<number>): ChainedFieldExpr<number>
  sub(v: number | FieldExpr<number>): ChainedFieldExpr<number>
  mul(v: number | FieldExpr<number>): ChainedFieldExpr<number>
  div(v: number | FieldExpr<number>): ChainedFieldExpr<number>
  round(): ChainedFieldExpr<number>
}

interface StringOps {
  gt(v: string | FieldExpr<string>): FilterExpression
  ge(v: string | FieldExpr<string>): FilterExpression
  lt(v: string | FieldExpr<string>): FilterExpression
  le(v: string | FieldExpr<string>): FilterExpression
  startsWith(v: string): FilterExpression
  endsWith(v: string): FilterExpression
  substringof(v: string): FilterExpression
  like(pattern: string): FilterExpression
  concat(other: string | FieldExpr<string>): ChainedFieldExpr<string>
  substring(start: number, length?: number): ChainedFieldExpr<string>
}

interface DateOps {
  gt(v: Date | FieldExpr<Date>): FilterExpression
  ge(v: Date | FieldExpr<Date>): FilterExpression
  lt(v: Date | FieldExpr<Date>): FilterExpression
  le(v: Date | FieldExpr<Date>): FilterExpression
  year(): ChainedFieldExpr<number>
  month(): ChainedFieldExpr<number>
  day(): ChainedFieldExpr<number>
  hour(): ChainedFieldExpr<number>
  minute(): ChainedFieldExpr<number>
  second(): ChainedFieldExpr<number>
  dayofweek(): ChainedFieldExpr<number>
  dayofyear(): ChainedFieldExpr<number>
  quarter(): ChainedFieldExpr<number>
  dateadd(
    unit: 'second' | 'minute' | 'hour' | 'day' | 'month' | 'quarter' | 'year',
    amount: number,
  ): ChainedFieldExpr<Date>
  datedifference(
    other: Date | FieldExpr<Date>,
    unit: 'second' | 'minute' | 'hour' | 'day' | 'month' | 'quarter' | 'year',
  ): ChainedFieldExpr<number>
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
 * `cast()` here is typed `ChainedFieldExpr<string>` because polymorphic-ref
 * pairs are the only composite kind we surface as `string`. The 1С platform
 * also accepts `cast`/`isof` on other composite-typed attrs (e.g. composite-
 * numeric requisites) — those aren't reachable through this typed surface;
 * fall back to `raw(...)` if you need them.
 */
interface RefOps {
  isof(typeName: string): FilterExpression
  cast(typeName: string): ChainedFieldExpr<string>
}

/**
 * An integer argument of a DSL function — `substring`'s start and length,
 * `dateadd`'s amount, which 1С takes as integers only: a fraction, a non-finite
 * or a non-number value is an `InvalidArgumentError` here rather than a 400
 * from the server.
 */
function intLiteral(v: number, argument: string): string {
  if (!Number.isSafeInteger(v)) {
    throw new InvalidArgumentError(`"${argument}" must be an integer; received ${String(v)}`, { argument, received: v })
  }
  return formatNumberLiteral(v, argument)
}

/** The units `dateadd` / `datedifference` take — the `DateOps` signature's list. */
const DATE_UNITS: ReadonlySet<unknown> = new Set(['second', 'minute', 'hour', 'day', 'month', 'quarter', 'year'])

/**
 * A `dateadd` / `datedifference` unit, written into the filter as is — so one
 * of `DATE_UNITS` only: the type admits no other, and untyped code passing
 * anything else gets an `InvalidArgumentError` rather than its text in `$filter`.
 */
function dateUnit(unit: unknown, argument: string): string {
  if (!DATE_UNITS.has(unit)) {
    throw new InvalidArgumentError(
      `Date unit for "${argument}" must be one of ${[...DATE_UNITS].join(', ')}; received ${typeof unit === 'string' ? `'${unit}'` : typeof unit}`,
      { argument, received: unit },
    )
  }
  return unit as string
}

/**
 * Build a FieldExpr-typed proxy. Every property access returns a wrapped
 * field expression with all method surfaces; TS narrowing via FieldExprFor<V>
 * controls which methods are visible at the type level. `schema` — the
 * entity's (or a tabular row's) where the query has one — gives each field its
 * declared type: whether its comparisons write a GUID string as `guid'…'`.
 *
 * @internal
 */
export function makeFieldProxy<T>(prefix: string, ctx: CompileContext, schema?: EntitySchema): FieldExprMap<T> {
  return new Proxy({} as FieldExprMap<T>, {
    get(_, key) {
      if (typeof key !== 'string') return undefined
      if (key === '_expr' || key === '_phantom' || key === '_ctx') return undefined
      const propType =
        schema !== undefined && Object.hasOwn(schema.properties, key) ? schema.properties[key]?.type : undefined
      const field = wrapField<unknown>(prefix + key, ctx, guidKind(prefix + key, propType))
      if (propType !== undefined) fieldTypes.set(field, propType)
      return field
    },
  })
}

function wrapField<V>(
  expr: string,
  ctx: CompileContext,
  kind: GuidKind = 'unknown',
): FieldExprFor<V> & FieldExpr<V> & { _ctx: CompileContext } {
  // A field holding a GUID writes a string operand as `guid'…'`; a computed
  // expression (`cast()`, arithmetic, functions) is of unknown kind and never does.
  const comparand = (v: unknown) => formatComparand(v, ctx, expr, kind)
  // Each arithmetic operation in its own parentheses: OData binds mul/div
  // tighter than add/sub, so a chain written bare — `A add 1 mul 2` — would not
  // compute what the calls say, `(A add 1) mul 2`.
  const arithmetic = (op: 'add' | 'sub' | 'mul' | 'div', v: unknown) =>
    wrapField<number>(`(${expr} ${op} ${formatLiteral(v, ctx, expr)})`, ctx)
  // Frozen: a registered expression's text cannot be swapped after the fact.
  const f = dslExpression(
    Object.freeze({
      _expr: expr,
      _ctx: ctx,
      eq: (v: unknown) => makeFilter(`${expr} eq ${comparand(v)}`),
      ne: (v: unknown) => makeFilter(`${expr} ne ${comparand(v)}`),
      gt: (v: unknown) => makeFilter(`${expr} gt ${comparand(v)}`),
      ge: (v: unknown) => makeFilter(`${expr} ge ${comparand(v)}`),
      lt: (v: unknown) => makeFilter(`${expr} lt ${comparand(v)}`),
      le: (v: unknown) => makeFilter(`${expr} le ${comparand(v)}`),
      startsWith: (v: string) => makeFilter(`startswith(${expr}, ${formatLiteral(v, ctx, expr)})`),
      endsWith: (v: string) => makeFilter(`endswith(${expr}, ${formatLiteral(v, ctx, expr)})`),
      substringof: (v: string) => makeFilter(`substringof(${formatLiteral(v, ctx, expr)}, ${expr})`),
      like: (pat: string) => makeFilter(`like(${expr}, ${formatLiteral(pat, ctx, expr)})`),
      concat: (other: unknown) => wrapField<string>(`concat(${expr}, ${formatLiteral(other, ctx, expr)})`, ctx),
      substring: (start: number, length?: number) => {
        const s = intLiteral(start, `${expr}:substring.start`)
        const inner =
          length !== undefined
            ? `substring(${expr}, ${s}, ${intLiteral(length, `${expr}:substring.length`)})`
            : `substring(${expr}, ${s})`
        return wrapField<string>(inner, ctx)
      },
      add: (v: unknown) => arithmetic('add', v),
      sub: (v: unknown) => arithmetic('sub', v),
      mul: (v: unknown) => arithmetic('mul', v),
      div: (v: unknown) => arithmetic('div', v),
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
      dateadd: (unit: string, amount: number) =>
        wrapField<Date>(
          `dateadd(${expr}, '${dateUnit(unit, `${expr}:dateadd.unit`)}', ${intLiteral(amount, `${expr}:dateadd.amount`)})`,
          ctx,
        ),
      datedifference: (other: unknown, unit: string) =>
        wrapField<number>(
          `datedifference(${expr}, ${formatLiteral(other, ctx, expr)}, '${dateUnit(unit, `${expr}:datedifference.unit`)}')`,
          ctx,
        ),
      isof: (typeName: string) => makeFilter(`isof(${expr}, ${formatLiteral(typeName, ctx, expr)})`),
      cast: (typeName: string) => wrapField<string>(`cast(${expr}, ${formatLiteral(typeName, ctx, expr)})`, ctx),
    }),
  )
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
