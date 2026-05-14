import { describe, expect, it } from 'vitest'
import { and, raw, toFilterString } from '../../../src/filter.js'

describe('toFilterString', () => {
  it('returns the OData wire string for a raw filter', () => {
    const f = raw("Code eq '001'")
    expect(toFilterString(f)).toBe("Code eq '001'")
  })

  it('returns the joined wire string for and()', () => {
    const f = and(raw("Code eq '001'"), raw('Sum gt 100'))
    expect(toFilterString(f)).toBe("Code eq '001' and Sum gt 100")
  })

  it('matches the value of _expr (parity invariant)', () => {
    const f = raw('A eq 1')
    // Cast required because `_expr` is marked @internal after Task 4.
    expect(toFilterString(f)).toBe((f as unknown as { _expr: string })._expr)
  })
})

describe('toFilterString — type safety', () => {
  it('rejects plain objects (nominal brand)', () => {
    // @ts-expect-error - plain object does not satisfy the FilterExpression brand
    toFilterString({})
    // @ts-expect-error - random shape does not satisfy the brand
    toFilterString({ _expr: 'fake' })
    // @ts-expect-error - string is not a FilterExpression
    toFilterString('Code eq "x"')
    // raw() output IS a valid FilterExpression — sanity check that valid args still compile
    toFilterString(raw('Code eq "x"'))
  })
})
