import { BasicAuth, InvalidArgumentError, ODataV3Client, QueryBuilder } from '@1c-odata/client'
import { describe, expect, it } from 'vitest'

type Phantom = { Code: string }

function newBuilder(): QueryBuilder<Phantom> {
  return new QueryBuilder<Phantom>('Catalog_X', 'Europe/Moscow')
}

describe('QueryBuilder.top() validation', () => {
  it.each([
    -1,
    -100,
    3.5,
    0.1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])('rejects %s with InvalidArgumentError', (value) => {
    expect(() => newBuilder().top(value)).toThrow(InvalidArgumentError)
    expect(() => newBuilder().top(value)).toThrow(/must be a non-negative integer/)
  })

  it.each([0, 1, 100, Number.MAX_SAFE_INTEGER])('accepts %s', (value) => {
    expect(() => newBuilder().top(value)).not.toThrow()
  })

  it('received field carries the rejected value', () => {
    let err: InvalidArgumentError | undefined
    try {
      newBuilder().top(-1)
    } catch (e) {
      err = e as InvalidArgumentError
    }
    expect(err?.received).toBe(-1)

    try {
      newBuilder().top(3.5)
    } catch (e) {
      err = e as InvalidArgumentError
    }
    expect(err?.received).toBe(3.5)

    try {
      newBuilder().top(Number.NaN)
    } catch (e) {
      err = e as InvalidArgumentError
    }
    expect(Number.isNaN(err?.received)).toBe(true)
  })
})

describe('QueryBuilder.skip() validation', () => {
  it.each([
    -1,
    -100,
    3.5,
    0.1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])('rejects %s with InvalidArgumentError', (value) => {
    expect(() => newBuilder().skip(value)).toThrow(InvalidArgumentError)
    expect(() => newBuilder().skip(value)).toThrow(/must be a non-negative integer/)
  })

  it.each([0, 1, 100, Number.MAX_SAFE_INTEGER])('accepts %s', (value) => {
    expect(() => newBuilder().skip(value)).not.toThrow()
  })
})

describe('V3QueryBuilder.stream() pageSize validation', () => {
  function makeStream(pageSize: number) {
    const client = new ODataV3Client({
      baseUrl: 'http://1c.test/odata',
      auth: BasicAuth({ username: 'u', password: 'p' }),
      serverTimezone: 'Europe/Moscow',
    })
    return client.query<{ Code: string }>('Catalog_X').stream({ pageSize })
  }

  it.each([
    0,
    -1,
    3.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects pageSize %s with InvalidArgumentError on first iteration', async (value) => {
    const iter = makeStream(value)
    await expect(iter.next()).rejects.toThrow(InvalidArgumentError)
    await expect(makeStream(value).next()).rejects.toThrow(/must be a positive integer/)
  })

  it('accepts pageSize 1 (no throw on construction)', () => {
    expect(() => makeStream(1)).not.toThrow()
  })
})
