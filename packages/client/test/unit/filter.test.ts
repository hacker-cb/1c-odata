import { describe, expect, it } from 'vitest'
import { InvalidArgumentError } from '../../src/errors.js'
import { all, and, any, not, or, raw } from '../../src/filter.js'
import { compileFilter, type FieldExprMap } from '../../src/query/filter-internal.js'

interface SampleEntity {
  Code: string
  Сумма: number
  Date: Date
  Active: boolean
  Recorder: string
  Товары: { Сумма: number; Активна: boolean }[]
}

describe('FilterBuilder — basic comparisons', () => {
  it('eq on string', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Code.eq('ABC'))).toBe(`Code eq 'ABC'`)
  })

  it('escapes single quotes in string literal', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Code.eq("O'Brien"))).toBe(`Code eq 'O''Brien'`)
  })

  it('gt on number', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Сумма.gt(100))).toBe('Сумма gt 100')
  })

  it('ne with boolean', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Active.ne(false))).toBe('Active ne false')
  })
})

describe('FilterBuilder — combinators', () => {
  it('and with multiple', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => and(f.Code.eq('A'), f.Сумма.gt(0)))).toBe(
      `Code eq 'A' and Сумма gt 0`,
    )
  })

  it('or', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => or(f.Code.eq('A'), f.Code.eq('B')))).toBe(
      `(Code eq 'A') or (Code eq 'B')`,
    )
  })

  it('not', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => not(f.Active.eq(true)))).toBe('not (Active eq true)')
  })

  it('and wraps or-operand to preserve precedence', () => {
    expect(
      compileFilter<SampleEntity>('Europe/Moscow', (f) => and(or(f.Code.eq('A'), f.Code.eq('B')), f.Active.eq(true))),
    ).toBe(`((Code eq 'A') or (Code eq 'B')) and Active eq true`)
  })

  it('and does not wrap leaf operands', () => {
    expect(
      compileFilter<SampleEntity>('Europe/Moscow', (f) =>
        and(f.Code.eq('A'), f.Code.like('foo or bar'), f.Active.eq(true)),
      ),
    ).toBe(`Code eq 'A' and like(Code, 'foo or bar') and Active eq true`)
  })
})

describe('FilterBuilder — string ops', () => {
  it('startsWith', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Code.startsWith('А'))).toBe(`startswith(Code, 'А')`)
  })

  it('like', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Code.like('А%'))).toBe(`like(Code, 'А%')`)
  })

  it('substringof', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Code.substringof('foo'))).toBe(
      `substringof('foo', Code)`,
    )
  })
})

describe('FilterBuilder — date ops', () => {
  it('year().eq(...)', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Date.year().eq(2025))).toBe('year(Date) eq 2025')
  })

  it('Date eq with literal serializes via TZ', () => {
    const fixed = new Date('2025-01-10T12:30:00.000Z')
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Date.eq(fixed))).toBe(
      `Date eq datetime'2025-01-10T15:30:00'`,
    )
  })

  it('gt with Date literal', () => {
    const fixed = new Date('2025-01-10T12:30:00.000Z')
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Date.gt(fixed))).toBe(
      `Date gt datetime'2025-01-10T15:30:00'`,
    )
  })
})

describe('FilterBuilder — number ops', () => {
  it('add then gt', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Сумма.add(5).gt(10))).toBe('(Сумма add 5) gt 10')
  })
})

describe('FilterBuilder — lambda', () => {
  it('any with simple predicate', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => any(f.Товары, (t) => t.Сумма.gt(10000)))).toBe(
      'Товары/any(t0: t0/Сумма gt 10000)',
    )
  })

  it('all with and predicate', () => {
    expect(
      compileFilter<SampleEntity>('Europe/Moscow', (f) => all(f.Товары, (t) => and(t.Сумма.gt(0), t.Активна.eq(true)))),
    ).toBe('Товары/all(t0: t0/Сумма gt 0 and t0/Активна eq true)')
  })
})

describe('FilterBuilder — polymorphic-ref ops', () => {
  it('isof', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Recorder.isof('Document_РТУ'))).toBe(
      `isof(Recorder, 'Document_РТУ')`,
    )
  })

  it('cast', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Recorder.cast('Document_РТУ').eq('abc'))).toBe(
      `cast(Recorder, 'Document_РТУ') eq 'abc'`,
    )
  })

  it('isof escapes single quotes in typeName (no filter injection)', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Recorder.isof("X' or 1 eq 1 or '"))).toBe(
      `isof(Recorder, 'X'' or 1 eq 1 or ''')`,
    )
  })

  it('cast escapes single quotes in typeName (no filter injection)', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Recorder.cast("X' or 1 eq 1").eq('y'))).toBe(
      `cast(Recorder, 'X'' or 1 eq 1') eq 'y'`,
    )
  })
})

describe('FilterBuilder — raw', () => {
  it('raw passes through', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', () => raw('exotic_call() gt 0'))).toBe('exotic_call() gt 0')
  })
})

describe('FilterBuilder — numeric literal validation', () => {
  it('throws InvalidArgumentError when filtering by NaN', () => {
    expect(() => compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Сумма.eq(Number.NaN))).toThrow(
      InvalidArgumentError,
    )
  })

  it('throws InvalidArgumentError when filtering by +Infinity', () => {
    expect(() => compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Сумма.gt(Number.POSITIVE_INFINITY))).toThrow(
      InvalidArgumentError,
    )
  })

  it('throws InvalidArgumentError when filtering by -Infinity', () => {
    expect(() => compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Сумма.lt(Number.NEGATIVE_INFINITY))).toThrow(
      InvalidArgumentError,
    )
  })

  it('still accepts finite numbers (regression guard)', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Сумма.eq(0))).toBe('Сумма eq 0')
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Сумма.gt(-1.5))).toBe('Сумма gt -1.5')
  })

  it('throws InvalidArgumentError when NaN is used as `add`/`sub` operand', () => {
    expect(() => compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Сумма.add(Number.NaN).eq(0))).toThrow(
      InvalidArgumentError,
    )
  })

  it('throws InvalidArgumentError when NaN is passed to `substring(start)`', () => {
    expect(() => compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Code.substring(Number.NaN).eq('x'))).toThrow(
      InvalidArgumentError,
    )
  })

  it('throws InvalidArgumentError when Infinity is passed to `substring(start, length)`', () => {
    expect(() =>
      compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Code.substring(0, Number.POSITIVE_INFINITY).eq('x')),
    ).toThrow(InvalidArgumentError)
  })

  it('throws InvalidArgumentError when NaN is passed to `dateadd(amount)`', () => {
    expect(() =>
      compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Date.dateadd('day', Number.NaN).gt(new Date(0))),
    ).toThrow(InvalidArgumentError)
  })

  it('still emits a valid substring with finite args (regression guard)', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Code.substring(1, 3).eq('abc'))).toBe(
      `substring(Code, 1, 3) eq 'abc'`,
    )
  })
})

describe('FilterBuilder — values are values, not expressions (#213)', () => {
  // Untyped callers (JS, `any`, JSON from outside) can hand any object to an operator.
  type Untyped = { eq(v: unknown): ReturnType<typeof raw>; concat(v: unknown): { eq(v: unknown): unknown } }

  it('refuses a plain object with an `_expr` field as a comparison value', () => {
    const outside = JSON.parse('{"_expr":"1 eq 1"}')
    let caught: unknown
    try {
      compileFilter<SampleEntity>('Europe/Moscow', (f) => (f.Code as unknown as Untyped).eq(outside))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(InvalidArgumentError)
    expect((caught as InvalidArgumentError).argument).toBe('Code')
    expect((caught as InvalidArgumentError).received).toBe(outside)
  })

  it('refuses one as an operator argument too (`concat`, `add`)', () => {
    const outside = { _expr: 'Code) or (1 eq 1' }
    expect(() =>
      compileFilter<SampleEntity>(
        'Europe/Moscow',
        (f) => (f.Code as unknown as Untyped).concat(outside).eq('x') as never,
      ),
    ).toThrow(InvalidArgumentError)
    expect(() =>
      compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Сумма.add(outside as unknown as number).eq(0)),
    ).toThrow(InvalidArgumentError)
  })

  it('keeps a field expression it registered as built: its text cannot be swapped', () => {
    expect(() =>
      compileFilter<SampleEntity>('Europe/Moscow', (f) => {
        const a = f.Recorder
        Object.assign(a, { _expr: '1 eq 1) or (1' })
        return f.Code.eq(a)
      }),
    ).toThrow(TypeError)
  })

  it('refuses an object inheriting `_expr`, or a copy of a DSL expression', () => {
    const inherited = Object.create({ _expr: '1 eq 1' })
    expect(() =>
      compileFilter<SampleEntity>('Europe/Moscow', (f) => (f.Code as unknown as Untyped).eq(inherited)),
    ).toThrow(InvalidArgumentError)
    expect(() =>
      compileFilter<SampleEntity>('Europe/Moscow', (f) => (f.Code as unknown as Untyped).eq({ ...raw('1 eq 1') })),
    ).toThrow(InvalidArgumentError)
  })

  it('still takes a field as the value (`f.A.eq(f.B)`) and a field expression as an operand', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Сумма.eq(f.Сумма))).toBe('Сумма eq Сумма')
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Сумма.gt(f.Сумма.mul(2)))).toBe(
      'Сумма gt (Сумма mul 2)',
    )
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Code.concat(f.Recorder).eq('x'))).toBe(
      `concat(Code, Recorder) eq 'x'`,
    )
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => any(f.Товары, (t) => t.Сумма.eq(f.Сумма)))).toBe(
      'Товары/any(t0: t0/Сумма eq Сумма)',
    )
  })

  it('still writes what raw() and the combinators build, as before', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', () => raw("Code eq 'A'"))).toBe("Code eq 'A'")
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => and(raw('Сумма gt 0'), not(f.Active.eq(true))))).toBe(
      'Сумма gt 0 and not (Active eq true)',
    )
  })

  it('refuses a value that cannot be read as InvalidArgumentError, not a TypeError', () => {
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    for (const v of [Object.create(null), JSON.parse('{"toString":"x"}'), revoked.proxy]) {
      let caught: unknown
      try {
        compileFilter<SampleEntity>('Europe/Moscow', (f) => (f.Code as unknown as Untyped).eq(v))
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(InvalidArgumentError)
      expect((caught as InvalidArgumentError).argument).toBe('Code')
      expect((caught as InvalidArgumentError).cause).toBeInstanceOf(TypeError)
    }
  })

  it('writes any other plain object as it did (its string form)', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => (f.Code as unknown as Untyped).eq({ a: 1 }))).toBe(
      `Code eq '[object Object]'`,
    )
  })
})

describe('FilterBuilder — date units (#213 review)', () => {
  it('writes each unit the signature lists', () => {
    for (const unit of ['second', 'minute', 'hour', 'day', 'month', 'quarter', 'year'] as const) {
      expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Date.dateadd(unit, 1).gt(f.Date))).toBe(
        `dateadd(Date, '${unit}', 1) gt Date`,
      )
    }
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Date.dateadd('quarter', 1).gt(f.Date))).toBe(
      "dateadd(Date, 'quarter', 1) gt Date",
    )
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Date.datedifference(f.Date, 'day').eq(0))).toBe(
      "datedifference(Date, Date, 'day') eq 0",
    )
  })

  it('refuses any other unit from untyped code instead of writing it into $filter', () => {
    const outside = "day', 1) or (1 eq 1"
    expect(() =>
      compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Date.dateadd(outside as 'day', 1).gt(new Date(0))),
    ).toThrow(InvalidArgumentError)
    expect(() =>
      compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Date.datedifference(f.Date, outside as 'day').eq(0)),
    ).toThrow(InvalidArgumentError)
    expect(() =>
      compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Date.dateadd(undefined as unknown as 'day', 1).gt(f.Date)),
    ).toThrow(InvalidArgumentError)
  })
})

describe('FilterBuilder — integer arguments (#213 review)', () => {
  it.each([
    ['dateadd amount', (f: FieldExprMap<SampleEntity>) => f.Date.dateadd('day', 0.5).gt(f.Date)],
    ['substring start', (f: FieldExprMap<SampleEntity>) => f.Code.substring(1.5).eq('x')],
    ['substring length', (f: FieldExprMap<SampleEntity>) => f.Code.substring(0, 2.5).eq('x')],
    ['a string amount', (f: FieldExprMap<SampleEntity>) => f.Date.dateadd('day', '1' as unknown as number).gt(f.Date)],
  ])('refuses a non-integer %s with InvalidArgumentError', (_name, fn) => {
    expect(() => compileFilter<SampleEntity>('Europe/Moscow', fn)).toThrow(InvalidArgumentError)
  })

  it('writes integer arguments, negative ones included', () => {
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Date.dateadd('day', -3).gt(f.Date))).toBe(
      "dateadd(Date, 'day', -3) gt Date",
    )
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Code.substring(0, 2).eq('x'))).toBe(
      "substring(Code, 0, 2) eq 'x'",
    )
  })
})

describe('FilterBuilder — arithmetic keeps the order of the calls', () => {
  const c = (fn: (f: FieldExprMap<SampleEntity>) => ReturnType<typeof raw>) => compileFilter<SampleEntity>('UTC', fn)

  it('wraps each single operation — the meaning of a lone one is unchanged', () => {
    expect(c((f) => f.Сумма.add(1).eq(2))).toBe('(Сумма add 1) eq 2')
    expect(c((f) => f.Сумма.sub(1).eq(2))).toBe('(Сумма sub 1) eq 2')
    expect(c((f) => f.Сумма.mul(2).eq(2))).toBe('(Сумма mul 2) eq 2')
    expect(c((f) => f.Сумма.div(2).eq(2))).toBe('(Сумма div 2) eq 2')
  })

  it('chains compute left to right, as called — not by OData precedence', () => {
    expect(c((f) => f.Сумма.add(1).mul(2).eq(10))).toBe('((Сумма add 1) mul 2) eq 10')
    expect(c((f) => f.Сумма.sub(1).div(2).eq(3))).toBe('((Сумма sub 1) div 2) eq 3')
    expect(c((f) => f.Сумма.mul(2).add(1).sub(3).eq(0))).toBe('(((Сумма mul 2) add 1) sub 3) eq 0')
  })

  it('an expression as the operand keeps its own grouping', () => {
    expect(c((f) => f.Сумма.mul(f.Сумма.add(2)).eq(12))).toBe('(Сумма mul (Сумма add 2)) eq 12')
    expect(c((f) => f.Сумма.div(f.Сумма.sub(1)).gt(0))).toBe('(Сумма div (Сумма sub 1)) gt 0')
  })

  it('a filter landing in a value slot from untyped code keeps its grouping', () => {
    type Untyped = {
      mul(v: unknown): { eq(v: unknown): ReturnType<typeof raw> }
      eq(v: unknown): ReturnType<typeof raw>
    }
    expect(c((f) => (f.Сумма as unknown as Untyped).mul(raw('Сумма add 2')).eq(10))).toBe(
      '(Сумма mul (Сумма add 2)) eq 10',
    )
    expect(c((f) => (f.Active as unknown as Untyped).eq(or(raw('A eq 1'), raw('B eq 2'))))).toBe(
      'Active eq ((A eq 1) or (B eq 2))',
    )
  })

  it('functions over an operation and lambdas take the grouped text', () => {
    expect(c((f) => f.Сумма.add(0.5).round().eq(3))).toBe('round((Сумма add 0.5)) eq 3')
    expect(c((f) => any(f.Товары, (t) => t.Сумма.mul(2).gt(10)))).toBe('Товары/any(t0: (t0/Сумма mul 2) gt 10)')
  })
})

describe('FilterBuilder — undefined is no value (#229)', () => {
  // Untyped callers (JS, `any`, a property missing from a row) reach a value slot with `undefined`.
  type Untyped = Record<
    string,
    (...v: unknown[]) => { eq(v: unknown): ReturnType<typeof raw> } & ReturnType<typeof raw>
  >
  const c = (fn: (f: FieldExprMap<SampleEntity>) => unknown) =>
    compileFilter<SampleEntity>('UTC', fn as (f: FieldExprMap<SampleEntity>) => ReturnType<typeof raw>)
  const u = (e: unknown) => e as Untyped

  it('a comparison with undefined is an InvalidArgumentError naming the field', () => {
    for (const op of ['eq', 'ne', 'gt', 'ge', 'lt', 'le']) {
      let caught: unknown
      try {
        c((f) => u(f.Сумма)[op]?.(undefined))
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(InvalidArgumentError)
      expect(caught).toMatchObject({ argument: 'Сумма', received: undefined })
    }
  })

  it('an operator argument too — arithmetic, string and date functions, isof/cast', () => {
    expect(() => c((f) => u(f.Сумма).add?.(undefined).eq(1))).toThrow(InvalidArgumentError)
    expect(() => c((f) => u(f.Code).concat?.(undefined).eq('x'))).toThrow(InvalidArgumentError)
    expect(() => c((f) => u(f.Code).startsWith?.(undefined))).toThrow(InvalidArgumentError)
    expect(() => c((f) => u(f.Code).like?.(undefined))).toThrow(InvalidArgumentError)
    expect(() => c((f) => u(f.Date).datedifference?.(undefined, 'day').eq(1))).toThrow(InvalidArgumentError)
    expect(() => c((f) => u(f.Recorder).isof?.(undefined))).toThrow(InvalidArgumentError)
    expect(() => c((f) => u(f.Recorder).cast?.(undefined).eq('x'))).toThrow(InvalidArgumentError)
  })

  it('a function or a symbol is no value either — an uncalled method, a symbol', () => {
    expect(() => c((f) => u(f.Сумма).eq?.(f.Date.year))).toThrow(InvalidArgumentError)
    expect(() => c((f) => u(f.Code).eq?.(Symbol('x')))).toThrow(InvalidArgumentError)
  })

  it('the types keep taking a value that may be undefined — the run time refuses an actual undefined', () => {
    type Gen = { Артикул?: string | null; Сумма: number | undefined }
    const gen = (fn: (f: FieldExprMap<Gen>) => ReturnType<typeof raw>) => compileFilter<Gen>('UTC', fn)
    const present: Gen = { Артикул: 'A-1', Сумма: 5 }
    const missing: Gen = { Сумма: undefined }
    // A generated optional field compared with a value read from a row compiles, as before.
    expect(gen((f) => f.Артикул.eq(present.Артикул))).toBe(`Артикул eq 'A-1'`)
    expect(gen((f) => f.Сумма.ne(present.Сумма))).toBe('Сумма ne 5')
    expect(gen((f) => f.Артикул.eq(null))).toBe('Артикул eq null')
    // The value actually missing is the old bug: an error now, not `'undefined'`.
    expect(() => gen((f) => f.Артикул.eq(missing.Артикул))).toThrow(InvalidArgumentError)
    expect(() => gen((f) => f.Сумма.eq(missing.Сумма))).toThrow(InvalidArgumentError)
  })

  it('in a lambda the error names the row path', () => {
    let caught: unknown
    try {
      c((f) => any(f.Товары, (t) => u(t.Сумма).gt?.(undefined) as ReturnType<typeof raw>))
    } catch (e) {
      caught = e
    }
    expect(caught).toMatchObject({ argument: 't0/Сумма' })
  })

  it('null still compares with an empty value', () => {
    expect(c((f) => u(f.Сумма).eq?.(null))).toBe('Сумма eq null')
  })

  it("substring's length left out is not a value — it still means 'to the end'", () => {
    expect(c((f) => f.Code.substring(2).eq('x'))).toBe(`substring(Code, 2) eq 'x'`)
  })
})
