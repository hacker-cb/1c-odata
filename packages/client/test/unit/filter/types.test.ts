// The DSL's operator surface for nullable fields and bigint (#230): what codegen
// emits — `Сумма?: number | null`, `Int64?: bigint | null`, `Товары?: Row[] | null`
// — gets its operators, and the forms that compiled before still compile.
import { describe, expect, expectTypeOf, it } from 'vitest'
import { all, and, any } from '../../../src/filter.js'
import {
  type ChainedFieldExpr,
  compileFilter,
  type FieldExprMap,
  type FilterExpression,
} from '../../../src/query/filter-internal.js'

interface Row {
  Номенклатура_Key?: string | null
  Количество?: number | null
}

// Shapes as `1c-odata generate` emits them: nullable properties optional and `| null`.
interface Doc {
  Сумма?: number | null
  Количество: number
  Дата?: Date | null
  Комментарий?: string | null
  Проведен?: boolean | null
  Int64?: bigint | null
  Int64Required: bigint
  Товары?: Row[] | null
  Услуги: Row[]
  Пусто: null
}

const c = (fn: (f: FieldExprMap<Doc>) => FilterExpression) => compileFilter<Doc>('UTC', fn)

describe('filter DSL types — nullable fields get their operators (#230)', () => {
  it('number | null: comparisons and arithmetic', () => {
    expect(c((f) => f.Сумма.gt(100))).toBe('Сумма gt 100')
    expect(c((f) => f.Сумма.add(5).le(f.Количество))).toBe('(Сумма add 5) le Количество')
    expect(c((f) => f.Сумма.mul(f.Количество).round().eq(10))).toBe('round((Сумма mul Количество)) eq 10')
    expect(c((f) => f.Сумма.eq(null))).toBe('Сумма eq null')
    expectTypeOf<FieldExprMap<Doc>['Сумма']['add']>().returns.toEqualTypeOf<ChainedFieldExpr<number>>()
  })

  it('Date | null, string | null, boolean | null', () => {
    expect(c((f) => f.Дата.year().eq(2025))).toBe('year(Дата) eq 2025')
    expect(c((f) => f.Комментарий.startsWith('А'))).toBe(`startswith(Комментарий, 'А')`)
    expect(c((f) => f.Комментарий.isof('Edm.String'))).toBe(`isof(Комментарий, 'Edm.String')`)
    expect(c((f) => f.Проведен.eq(true))).toBe('Проведен eq true')
  })

  it('a field that holds only null keeps eq / ne, and nothing it cannot have', () => {
    expect(c((f) => f.Пусто.eq(null))).toBe('Пусто eq null')
    // @ts-expect-error — no numeric operators on a null-only field
    expect(() => c((f) => f.Пусто.gt(1))).toBeTypeOf('function')
  })

  it('the operator families stay apart', () => {
    // @ts-expect-error — a string field has no arithmetic
    expect(() => c((f) => f.Комментарий.add(1).eq(1))).toBeTypeOf('function')
    // @ts-expect-error — a number field has no startsWith
    expect(() => c((f) => f.Сумма.startsWith('1'))).toBeTypeOf('function')
    // @ts-expect-error — a number field compares with numbers, not strings
    expect(() => c((f) => f.Сумма.gt('1'))).toBeTypeOf('function')
  })
})

describe('filter DSL types — bigint (int64Mode: bigint) (#230)', () => {
  it('operands are bigint or number; arithmetic stays bigint', () => {
    expect(c((f) => f.Int64.gt(5n))).toBe('Int64 gt 5')
    expect(c((f) => f.Int64.add(1n).eq(10n))).toBe('(Int64 add 1) eq 10')
    expect(c((f) => f.Int64Required.sub(f.Int64Required).lt(0n))).toBe('(Int64Required sub Int64Required) lt 0')
    expectTypeOf<FieldExprMap<Doc>['Int64']['add']>().returns.toEqualTypeOf<ChainedFieldExpr<bigint>>()
    expectTypeOf<FieldExprMap<Doc>['Int64']['round']>().returns.toEqualTypeOf<ChainedFieldExpr<bigint>>()
  })

  it('the old forms with number operands still compile', () => {
    expect(c((f) => f.Int64.gt(5))).toBe('Int64 gt 5')
    expect(c((f) => f.Int64.add(1).eq(5))).toBe('(Int64 add 1) eq 5')
    expect(c((f) => f.Int64Required.eq(5))).toBe('Int64Required eq 5')
    expect(c((f) => f.Int64.mul(f.Количество).ne(0))).toBe('(Int64 mul Количество) ne 0')
  })

  it('a number field does not take a bigint', () => {
    // @ts-expect-error — bigint is for Int64 fields read as bigint
    expect(() => c((f) => f.Количество.gt(5n))).toBeTypeOf('function')
  })
})

describe('filter DSL types — any() / all() over a nullable tabular part (#230)', () => {
  it('a generated optional collection (`Товары?: Row[] | null`) takes a lambda', () => {
    expect(c((f) => any(f.Товары, (t) => t.Количество.gt(0)))).toBe('Товары/any(t0: t0/Количество gt 0)')
    expect(c((f) => all(f.Товары, (t) => t.Номенклатура_Key.ne(null)))).toBe(
      'Товары/all(t0: t0/Номенклатура_Key ne null)',
    )
    expect(c((f) => and(any(f.Услуги, (t) => t.Количество.add(1).ge(2))))).toBe(
      'Услуги/any(t0: (t0/Количество add 1) ge 2)',
    )
  })

  it('a non-collection field is still refused', () => {
    // @ts-expect-error — any() takes a collection
    expect(() => c((f) => any(f.Сумма, () => f.Сумма.gt(0)))).toBeTypeOf('function')
  })
})
