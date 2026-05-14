import { describe, expect, it } from 'vitest'
import { mergeHeadersCaseInsensitive } from '../../src/client/v3-client.js'

describe('mergeHeadersCaseInsensitive', () => {
  it('returns empty object when no sources given', () => {
    expect(mergeHeadersCaseInsensitive()).toEqual({})
  })

  it('preserves keys without case conflict', () => {
    const r = mergeHeadersCaseInsensitive({ Accept: 'a', Authorization: 'b' })
    expect(r).toEqual({ Accept: 'a', Authorization: 'b' })
  })

  it('later source overrides earlier source on case-insensitive name match', () => {
    const r = mergeHeadersCaseInsensitive({ Authorization: 'old', Accept: 'x' }, { authorization: 'new' })
    expect(Object.keys(r).sort()).toEqual(['Accept', 'authorization'])
    expect(r.authorization).toBe('new')
    expect(r.Authorization).toBeUndefined()
  })

  it('preserves the casing of whichever override came last', () => {
    const r = mergeHeadersCaseInsensitive({ 'content-type': 'A' }, { 'Content-Type': 'B' })
    expect(Object.keys(r)).toEqual(['Content-Type'])
    expect(r['Content-Type']).toBe('B')
    expect(r['content-type']).toBeUndefined()
  })

  it('three-source merge: library-managed wins regardless of user override case', () => {
    const r = mergeHeadersCaseInsensitive({ Accept: '*/*' }, { 'content-type': 'X' }, { 'Content-Type': 'json' })
    expect(r['Content-Type']).toBe('json')
    expect(r['content-type']).toBeUndefined()
    expect(r.Accept).toBe('*/*')
  })

  it('does not mutate input objects', () => {
    const a = { Authorization: 'x' }
    const b = { authorization: 'y' }
    const beforeA = JSON.stringify(a)
    const beforeB = JSON.stringify(b)
    mergeHeadersCaseInsensitive(a, b)
    expect(JSON.stringify(a)).toBe(beforeA)
    expect(JSON.stringify(b)).toBe(beforeB)
  })

  it('handles repeated overrides within the same source object', () => {
    const r = mergeHeadersCaseInsensitive({ Authorization: 'one', authorization: 'two' })
    expect(Object.keys(r)).toHaveLength(1)
    expect(Object.values(r)).toEqual(['two'])
  })
})
