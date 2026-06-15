import { describe, expect, it } from 'vitest'
import { InvalidArgumentError } from '../../src/errors.js'
import { formatNumberLiteral } from '../../src/format-number.js'

describe('formatNumberLiteral', () => {
  it('formats finite integers as decimal', () => {
    expect(formatNumberLiteral(0, 'Amount')).toBe('0')
    expect(formatNumberLiteral(42, 'Amount')).toBe('42')
    expect(formatNumberLiteral(-7, 'Amount')).toBe('-7')
  })

  it('formats finite floats with JS default `String()` representation', () => {
    expect(formatNumberLiteral(3.14, 'Rate')).toBe('3.14')
    expect(formatNumberLiteral(-0.5, 'Discount')).toBe('-0.5')
  })

  it('throws InvalidArgumentError on NaN with the argument name in the message', () => {
    expect(() => formatNumberLiteral(Number.NaN, 'Amount')).toThrow(InvalidArgumentError)
    try {
      formatNumberLiteral(Number.NaN, 'Amount')
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidArgumentError)
      expect((e as InvalidArgumentError).argument).toBe('Amount')
      expect((e as Error).message).toMatch(/finite/i)
      expect((e as Error).message).toContain('Amount')
    }
  })

  it('throws InvalidArgumentError on +Infinity', () => {
    expect(() => formatNumberLiteral(Number.POSITIVE_INFINITY, 'Rate')).toThrow(InvalidArgumentError)
  })

  it('throws InvalidArgumentError on -Infinity', () => {
    expect(() => formatNumberLiteral(Number.NEGATIVE_INFINITY, 'Rate')).toThrow(InvalidArgumentError)
  })

  it('attaches the received value for diagnosis', () => {
    expect.assertions(1)
    try {
      formatNumberLiteral(Number.NaN, 'X')
    } catch (e) {
      expect((e as InvalidArgumentError).received).toBeNaN()
    }
  })

  it('expands small fractions out of exponential notation (no `e` in OData V3 literals)', () => {
    expect(String(1e-7)).toContain('e') // precondition: JS renders this exponentially
    expect(formatNumberLiteral(1e-7, 'Amount')).toBe('0.0000001')
    expect(formatNumberLiteral(1.5e-7, 'Amount')).toBe('0.00000015')
    expect(formatNumberLiteral(-1e-7, 'Amount')).toBe('-0.0000001')
  })

  it('expands large magnitudes out of exponential notation', () => {
    expect(String(1e21)).toContain('e') // precondition
    expect(formatNumberLiteral(1e21, 'Amount')).toBe(`1${'0'.repeat(21)}`)
  })

  it('never emits an exponential literal for representative finite inputs', () => {
    for (const v of [1e-7, 1e-9, 1e21, 1e30, -1e-8, 3.14, 0.0001, 42]) {
      expect(formatNumberLiteral(v, 'X')).not.toMatch(/[eE]/)
    }
  })
})
