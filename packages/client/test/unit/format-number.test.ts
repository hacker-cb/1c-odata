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
    }
  })

  it('throws InvalidArgumentError on +Infinity', () => {
    expect(() => formatNumberLiteral(Number.POSITIVE_INFINITY, 'Rate')).toThrow(InvalidArgumentError)
  })

  it('throws InvalidArgumentError on -Infinity', () => {
    expect(() => formatNumberLiteral(Number.NEGATIVE_INFINITY, 'Rate')).toThrow(InvalidArgumentError)
  })

  it('attaches the received value for diagnosis', () => {
    try {
      formatNumberLiteral(Number.NaN, 'X')
    } catch (e) {
      expect((e as InvalidArgumentError).received).toBeNaN()
    }
  })
})
