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
  Скидка?: number | null
  ДатаОкончания?: Date | null
  Описание?: string | null
  Счётчик: number | bigint
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
    expectTypeOf<FieldExprMap<Doc>['Сумма']['add']>().returns.toEqualTypeOf<ChainedFieldExpr<number | null>>()
  })

  it('Date | null, string | null, boolean | null', () => {
    expect(c((f) => f.Дата.year().eq(2025))).toBe('year(Дата) eq 2025')
    expect(c((f) => f.Комментарий.startsWith('А'))).toBe(`startswith(Комментарий, 'А')`)
    expect(c((f) => f.Комментарий.isof('Edm.String'))).toBe(`isof(Комментарий, 'Edm.String')`)
    expect(c((f) => f.Проведен.eq(true))).toBe('Проведен eq true')
  })

  it('a nullable field is an operand too — field with field', () => {
    expect(c((f) => f.Количество.gt(f.Сумма))).toBe('Количество gt Сумма')
    expect(c((f) => f.Сумма.add(f.Скидка).ge(0))).toBe('(Сумма add Скидка) ge 0')
    expect(c((f) => f.Дата.lt(f.ДатаОкончания))).toBe('Дата lt ДатаОкончания')
    expect(c((f) => f.Комментарий.concat(f.Описание).eq('x'))).toBe(`concat(Комментарий, Описание) eq 'x'`)
    expect(c((f) => f.Количество.eq(f.Сумма))).toBe('Количество eq Сумма')
  })

  it('arithmetic on a nullable field keeps its null', () => {
    expect(c((f) => f.Сумма.add(1).eq(null))).toBe('(Сумма add 1) eq null')
    expectTypeOf<FieldExprMap<Doc>['Сумма']['add']>().returns.toEqualTypeOf<ChainedFieldExpr<number | null>>()
    // A non-null field's arithmetic stays non-null, as before.
    expectTypeOf<FieldExprMap<Doc>['Количество']['add']>().returns.toEqualTypeOf<ChainedFieldExpr<number>>()
  })

  it('a field that holds only null keeps eq / ne, and nothing it cannot have', () => {
    expect(c((f) => f.Пусто.eq(null))).toBe('Пусто eq null')
    expectTypeOf<FieldExprMap<Doc>['Пусто']>().not.toHaveProperty('gt')
  })

  it('the operator families stay apart', () => {
    expectTypeOf<FieldExprMap<Doc>['Комментарий']>().not.toHaveProperty('add')
    expectTypeOf<FieldExprMap<Doc>['Сумма']>().not.toHaveProperty('startsWith')
    expectTypeOf<FieldExprMap<Doc>['Сумма']['gt']>().parameter(0).not.toEqualTypeOf<string>()
    // @ts-expect-error — a number field compares with numbers, not strings
    const bad = (f: FieldExprMap<Doc>) => f.Сумма.gt('1')
    expect(bad).toBeTypeOf('function')
  })
})

describe('filter DSL types — bigint (int64Mode: bigint) (#230)', () => {
  it('operands are bigint or number; arithmetic stays bigint', () => {
    expect(c((f) => f.Int64.gt(5n))).toBe('Int64 gt 5')
    expect(c((f) => f.Int64.add(1n).eq(10n))).toBe('(Int64 add 1) eq 10')
    expect(c((f) => f.Int64Required.sub(f.Int64Required).lt(0n))).toBe('(Int64Required sub Int64Required) lt 0')
    expectTypeOf<FieldExprMap<Doc>['Int64']['add']>().returns.toEqualTypeOf<ChainedFieldExpr<bigint | null>>()
    expectTypeOf<FieldExprMap<Doc>['Int64Required']['round']>().returns.toEqualTypeOf<ChainedFieldExpr<bigint>>()
  })

  it('the old forms with number operands still compile', () => {
    expect(c((f) => f.Int64.gt(5))).toBe('Int64 gt 5')
    expect(c((f) => f.Int64.add(1).eq(5))).toBe('(Int64 add 1) eq 5')
    expect(c((f) => f.Int64Required.eq(5))).toBe('Int64Required eq 5')
    expect(c((f) => f.Int64.mul(f.Количество).ne(0))).toBe('(Int64 mul Количество) ne 0')
  })

  it("numeric fields mix both ways — a bigint expression is a number field's operand too", () => {
    expect(c((f) => f.Количество.lt(f.Int64.mul(2)))).toBe('Количество lt (Int64 mul 2)')
    expect(c((f) => f.Количество.eq(f.Int64Required.add(1)))).toBe('Количество eq (Int64Required add 1)')
    expect(c((f) => f.Количество.add(f.Int64Required).gt(5n))).toBe('(Количество add Int64Required) gt 5')
    expect(c((f) => f.Int64Required.gt(f.Количество))).toBe('Int64Required gt Количество')
  })

  it('a field typed number | bigint (shared across int64 modes) keeps the numeric operators', () => {
    expect(c((f) => f.Счётчик.gt(5))).toBe('Счётчик gt 5')
    expect(c((f) => f.Счётчик.add(1n).eq(2))).toBe('(Счётчик add 1) eq 2')
    expectTypeOf<FieldExprMap<Doc>['Счётчик']['add']>().returns.toEqualTypeOf<ChainedFieldExpr<number | bigint>>()
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

  it('a non-collection field is still refused — a null-only one too', () => {
    // @ts-expect-error — any() takes a collection
    const scalar = (f: FieldExprMap<Doc>) => any(f.Сумма, () => f.Сумма.gt(0))
    // @ts-expect-error — a field that holds only null is no collection
    const nothing = (f: FieldExprMap<Doc>) => all(f.Пусто, () => f.Сумма.gt(0))
    expect([scalar, nothing]).toHaveLength(2)
  })

  it('an explicit row type and an any-typed field still work as before', () => {
    expect(c((f) => any<Row>(f.Товары, (t) => t.Количество.gt(0)))).toBe('Товары/any(t0: t0/Количество gt 0)')
    const loose = compileFilter<Record<string, unknown>>('UTC', (f) =>
      any(f.Rows as never as FieldExprMap<{ Rows: { B: number }[] }>['Rows'], (t) => t.B.gt(1)),
    )
    expect(loose).toBe('Rows/any(t0: t0/B gt 1)')
  })
})
