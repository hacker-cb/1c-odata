import { describe, expect, it } from 'vitest'
import { InvalidArgumentError } from '../../src/errors.js'
import { all, and, any, guid, not, or, raw } from '../../src/filter.js'
import { QueryBuilder } from '../../src/query/builder.js'
import type { FieldExprMap, FilterExpression } from '../../src/query/filter-internal.js'

describe('QueryBuilder state', () => {
  it('captures filter / select / top / skip / orderBy', () => {
    const q = new QueryBuilder<{ Code: string; Description: string }>('Catalog_X', 'Europe/Moscow')
      .filter((f) => and(f.Code.eq('999'), f.Description.gt('А')))
      .select('Code', 'Description')
      .orderBy('Description')
      .top(50)
      .skip(100)

    expect(q.entitySet).toBe('Catalog_X')
    expect(q.state.filter?._expr).toContain("Code eq '999'")
    expect(q.state.select).toEqual(['Code', 'Description'])
    expect(q.state.top).toBe(50)
    expect(q.state.skip).toBe(100)
    expect(q.state.orderBy).toEqual([{ field: 'Description', dir: 'asc' }])
  })

  it('orderBy supports desc', () => {
    const q = new QueryBuilder('Catalog_X', 'Europe/Moscow').orderBy('Date', 'desc')
    expect(q.state.orderBy).toEqual([{ field: 'Date', dir: 'desc' }])
  })

  it('expand and withCount', () => {
    const q = new QueryBuilder('Catalog_X', 'Europe/Moscow').expand('Контрагент').withCount()
    expect(q.state.expand).toEqual(['Контрагент'])
    expect(q.state.inlineCount).toBe(true)
  })

  it('headersOnly is sugar over select(**)', () => {
    const q = new QueryBuilder('Document_X', 'Europe/Moscow').headersOnly()
    expect(q.state.select).toEqual(['**'])
  })

  it('chaining returns same instance reference (fluent)', () => {
    const q = new QueryBuilder('Catalog_X', 'Europe/Moscow')
    expect(q.top(10).skip(0).orderBy('Code')).toBe(q)
  })
})

describe('QueryBuilder.filter — the callback returns a condition', () => {
  type Row = { A: number; Code: string; Active: boolean; Rows: { B: number }[] }
  const loose = (fn: unknown) => fn as (f: FieldExprMap<Row>) => FilterExpression
  const G = '8af68945-1c2d-11ef-9b6a-00155d102d01'

  it('undefined is an InvalidArgumentError and keeps the filter set before', () => {
    const q = new QueryBuilder<Row>('Catalog_X', 'Europe/Moscow').filter((f) => f.A.eq(1))
    let caught: unknown
    try {
      q.filter(loose(() => undefined))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(InvalidArgumentError)
    expect(caught).toMatchObject({ argument: 'filter() callback result', received: undefined })
    expect(q.state.filter?._expr).toBe('A eq 1')
  })

  it.each([
    ['null', null],
    ['a string', 'A eq 1'],
    ['an object without _expr text', { expr: 'A eq 1' }],
    ['a guid() literal', guid(G)],
  ])('%s is refused too', (_, value) => {
    const q = new QueryBuilder<Row>('Catalog_X', 'Europe/Moscow')
    expect(() => q.filter(loose(() => value))).toThrow(InvalidArgumentError)
    expect(q.state.filter).toBeUndefined()
  })

  it('a filter, raw(), a boolean field and a copy of a filter are taken', () => {
    const q = new QueryBuilder<Row>('Catalog_X', 'Europe/Moscow')
    expect(q.filter((f) => f.Code.eq('x')).state.filter?._expr).toBe(`Code eq 'x'`)
    expect(q.filter(() => raw('A gt 0')).state.filter?._expr).toBe('A gt 0')
    expect(q.filter(loose((f: FieldExprMap<Row>) => f.Active)).state.filter?._expr).toBe('Active')
    // A typed copy (spread, a callable carrying it) keeps its text: no membership check to fail it.
    expect(q.filter(() => ({ ...raw('A eq 1') })).state.filter?._expr).toBe('A eq 1')
    expect(q.filter(() => Object.assign(() => undefined, raw('A eq 2'))).state.filter?._expr).toBe('A eq 2')
  })

  it('the combinators refuse a non-condition operand with an InvalidArgumentError, not a TypeError', () => {
    const q = new QueryBuilder<Row>('Catalog_X', 'Europe/Moscow').filter((f) => f.A.eq(1))
    const none = undefined as unknown as FilterExpression
    for (const build of [
      (f: FieldExprMap<Row>) => and(f.A.eq(1), none),
      (f: FieldExprMap<Row>) => or(f.A.eq(1), guid(G) as unknown as FilterExpression),
      () => not(none),
      (f: FieldExprMap<Row>) => any(f.Rows, () => none),
      () => any(undefined as unknown as FieldExprMap<Row>['Rows'], () => raw('B gt 0')),
      (f: FieldExprMap<Row>) => all(f.Rows, (() => 'B gt 0') as unknown as () => FilterExpression),
    ]) {
      expect(() => q.filter(build)).toThrow(InvalidArgumentError)
    }
    expect(q.state.filter?._expr).toBe('A eq 1')
  })

  it('an unreadable result (a revoked Proxy) is an InvalidArgumentError with its cause', () => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    let caught: unknown
    try {
      new QueryBuilder<Row>('Catalog_X', 'Europe/Moscow').filter(loose(() => proxy))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(InvalidArgumentError)
    expect((caught as InvalidArgumentError).cause).toBeInstanceOf(TypeError)
  })

  it('typed code cannot return undefined from the callback', () => {
    const q = new QueryBuilder<Row>('Catalog_X', 'Europe/Moscow')
    const build: ((f: FieldExprMap<Row>) => FilterExpression) | undefined = undefined as
      | ((f: FieldExprMap<Row>) => FilterExpression)
      | undefined
    // @ts-expect-error — the callback's result must be a FilterExpression, not FilterExpression | undefined
    expect(() => q.filter((f) => build?.(f))).toThrow(InvalidArgumentError)
  })
})
