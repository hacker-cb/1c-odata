import { describe, expect, it } from 'vitest'
import { InvalidArgumentError } from '../../src/errors.js'
import { all, and, any, not, or, raw } from '../../src/filter.js'
import { compileFilter } from '../../src/query/filter-internal.js'

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
    expect(compileFilter<SampleEntity>('Europe/Moscow', (f) => f.Сумма.add(5).gt(10))).toBe('Сумма add 5 gt 10')
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
})
