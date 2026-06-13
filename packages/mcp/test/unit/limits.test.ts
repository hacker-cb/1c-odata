import { describe, expect, it } from 'vitest'
import { clampTop, DEFAULT_TOP, MAX_TOP } from '../../src/limits.js'

describe('clampTop', () => {
  it('defaults when undefined or invalid', () => {
    expect(clampTop(undefined)).toBe(DEFAULT_TOP)
    expect(clampTop(0)).toBe(DEFAULT_TOP)
    expect(clampTop(-5)).toBe(DEFAULT_TOP)
    expect(clampTop(3.5)).toBe(DEFAULT_TOP)
  })

  it('passes through valid values', () => {
    expect(clampTop(10)).toBe(10)
    expect(clampTop(MAX_TOP)).toBe(MAX_TOP)
  })

  it('caps at MAX_TOP', () => {
    expect(clampTop(99_999)).toBe(MAX_TOP)
  })
})
