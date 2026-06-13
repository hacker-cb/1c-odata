import { describe, expect, it } from 'vitest'
import { clampTop, DEFAULT_LIMITS, resolveLimits } from '../../src/limits.js'

describe('resolveLimits', () => {
  it('returns the built-in defaults when env is empty', () => {
    expect(resolveLimits({})).toEqual(DEFAULT_LIMITS)
  })

  it('reads ONEC_MCP_* overrides', () => {
    expect(resolveLimits({ ONEC_MCP_DEFAULT_TOP: '10', ONEC_MCP_MAX_TOP: '200', ONEC_MCP_MAX_BYTES: '5000' })).toEqual({
      defaultTop: 10,
      maxTop: 200,
      maxBytes: 5000,
    })
  })

  it('ignores invalid / out-of-range values and falls back to defaults', () => {
    // 'x' → NaN, '0' < 1, '10' < 1024 minimum
    expect(resolveLimits({ ONEC_MCP_DEFAULT_TOP: 'x', ONEC_MCP_MAX_TOP: '0', ONEC_MCP_MAX_BYTES: '10' })).toEqual(
      DEFAULT_LIMITS,
    )
  })

  it('clamps defaultTop to maxTop on misconfiguration', () => {
    expect(resolveLimits({ ONEC_MCP_DEFAULT_TOP: '500', ONEC_MCP_MAX_TOP: '100' })).toMatchObject({
      defaultTop: 100,
      maxTop: 100,
    })
  })

  it('accepts maxBytes at its 1024 floor but rejects below it', () => {
    expect(resolveLimits({ ONEC_MCP_MAX_BYTES: '1024' }).maxBytes).toBe(1024)
    expect(resolveLimits({ ONEC_MCP_MAX_BYTES: '1023' }).maxBytes).toBe(DEFAULT_LIMITS.maxBytes)
  })

  it('rejects non-decimal forms (hex, exponential, float, sign) and trims whitespace', () => {
    expect(resolveLimits({ ONEC_MCP_MAX_TOP: '1e9' }).maxTop).toBe(DEFAULT_LIMITS.maxTop)
    expect(resolveLimits({ ONEC_MCP_MAX_TOP: '0x10' }).maxTop).toBe(DEFAULT_LIMITS.maxTop)
    expect(resolveLimits({ ONEC_MCP_MAX_TOP: '-5' }).maxTop).toBe(DEFAULT_LIMITS.maxTop)
    expect(resolveLimits({ ONEC_MCP_MAX_TOP: '10.5' }).maxTop).toBe(DEFAULT_LIMITS.maxTop)
    expect(resolveLimits({ ONEC_MCP_MAX_TOP: '  200  ' }).maxTop).toBe(200)
  })
})

describe('clampTop', () => {
  const limits = { defaultTop: 50, maxTop: 1000, maxBytes: 24_000 }

  it('defaults when undefined or invalid', () => {
    expect(clampTop(undefined, limits)).toBe(50)
    expect(clampTop(0, limits)).toBe(50)
    expect(clampTop(-5, limits)).toBe(50)
    expect(clampTop(3.5, limits)).toBe(50)
  })

  it('passes through valid values and caps at maxTop', () => {
    expect(clampTop(10, limits)).toBe(10)
    expect(clampTop(1000, limits)).toBe(1000)
    expect(clampTop(99_999, limits)).toBe(1000)
  })
})
