import { describe, expect, it } from 'vitest'
import { canonicalJSON, computeInputs } from '../../src/commands/_input-hash.js'

describe('canonicalJSON', () => {
  it('sorts top-level keys alphabetically', () => {
    expect(canonicalJSON({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })

  it('sorts nested object keys recursively', () => {
    expect(canonicalJSON({ z: { y: 1, x: 2 }, a: { c: 3, b: 4 } })).toBe('{"a":{"b":4,"c":3},"z":{"x":2,"y":1}}')
  })

  it('preserves array order (arrays are ordered, not sets)', () => {
    expect(canonicalJSON({ k: [3, 1, 2] })).toBe('{"k":[3,1,2]}')
  })

  it('produces identical output for objects built in different orders', () => {
    const a = { b: 1, a: 2 }
    const b: { a: number; b: number } = { a: 0, b: 0 }
    b.a = 2
    b.b = 1
    expect(canonicalJSON(a)).toBe(canonicalJSON(b))
  })

  it('skips undefined values like JSON.stringify', () => {
    expect(canonicalJSON({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('handles primitives and null', () => {
    expect(canonicalJSON('hello')).toBe('"hello"')
    expect(canonicalJSON(42)).toBe('42')
    expect(canonicalJSON(null)).toBe('null')
    expect(canonicalJSON(true)).toBe('true')
  })

  it('returns a string for top-level undefined (not the value undefined)', () => {
    // JSON.stringify(undefined) returns the value `undefined`, which would
    // violate the `: string` return contract. Defensive branch returns 'null'.
    const result: string = canonicalJSON(undefined)
    expect(result).toBe('null')
  })
})

describe('computeInputs', () => {
  const xml = '<?xml version="1.0"?><Edmx/>'
  const opts = { int64Mode: 'string' as const, include: ['Catalog_*'] }
  const cliVersion = '0.1.0'

  it('returns three sha256: prefixed strings + cliVersion verbatim', () => {
    const r = computeInputs(xml, opts, cliVersion)
    expect(r.metadata).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(r.options).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(r.cliVersion).toBe('0.1.0')
  })

  it('produces stable output for stable inputs', () => {
    const a = computeInputs(xml, opts, cliVersion)
    const b = computeInputs(xml, opts, cliVersion)
    expect(a).toEqual(b)
  })

  it('changes metadata hash when XML differs by 1 byte', () => {
    const a = computeInputs(xml, opts, cliVersion)
    const b = computeInputs(`${xml} `, opts, cliVersion)
    expect(a.metadata).not.toBe(b.metadata)
    expect(a.options).toBe(b.options)
    expect(a.cliVersion).toBe(b.cliVersion)
  })

  it('changes options hash when shape differs', () => {
    const a = computeInputs(xml, { int64Mode: 'string' }, cliVersion)
    const b = computeInputs(xml, { int64Mode: 'bigint' }, cliVersion)
    expect(a.options).not.toBe(b.options)
    expect(a.metadata).toBe(b.metadata)
  })

  it('produces identical options hash when option key order varies in source object', () => {
    const a = computeInputs(xml, { int64Mode: 'string', include: ['X'] }, cliVersion)
    const b = computeInputs(xml, { include: ['X'], int64Mode: 'string' }, cliVersion)
    expect(a.options).toBe(b.options)
  })

  it('changes cliVersion when version differs', () => {
    const a = computeInputs(xml, opts, '0.1.0')
    const b = computeInputs(xml, opts, '0.2.0')
    expect(a.cliVersion).not.toBe(b.cliVersion)
  })
})
