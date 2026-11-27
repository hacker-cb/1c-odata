import { describe, expect, it } from 'vitest'
import { setOwn } from '../../src/own-key.js'

describe('setOwn (#275)', () => {
  it('writes `__proto__` as an own enumerable field and leaves the prototype alone', () => {
    const dict: Record<string, unknown> = {}
    setOwn(dict, '__proto__', { x: 1 })
    expect(Object.getPrototypeOf(dict)).toBe(Object.prototype)
    expect(Object.keys(dict)).toEqual(['__proto__'])
    expect(Object.getOwnPropertyDescriptor(dict, '__proto__')).toEqual({
      value: { x: 1 },
      writable: true,
      enumerable: true,
      configurable: true,
    })
    expect((dict as { x?: unknown }).x).toBeUndefined()
    expect(JSON.stringify(dict)).toBe('{"__proto__":{"x":1}}')
  })

  it('a non-object value under `__proto__` is kept, not dropped', () => {
    const dict: Record<string, unknown> = {}
    setOwn(dict, '__proto__', 'a')
    expect(Object.getOwnPropertyDescriptor(dict, '__proto__')?.value).toBe('a')
  })

  it('any other key is assigned as usual, in insertion order', () => {
    const dict: Record<string, unknown> = {}
    setOwn(dict, 'a', 1)
    setOwn(dict, '__proto__', 2)
    setOwn(dict, 'constructor', 3)
    expect(Object.keys(dict)).toEqual(['a', '__proto__', 'constructor'])
    expect(dict.constructor).toBe(3)
  })
})
