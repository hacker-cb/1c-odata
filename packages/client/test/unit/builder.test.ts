import { describe, expect, it } from 'vitest'
import { InvalidArgumentError } from '../../src/errors.js'
import { and, guid, raw } from '../../src/filter.js'
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

describe('QueryBuilder.filter — the callback returns a DSL expression', () => {
  type Row = { A: number; Code: string; Active: boolean }
  const loose = (fn: unknown) => fn as (f: FieldExprMap<Row>) => FilterExpression

  it('undefined is an InvalidArgumentError and keeps the filter set before', () => {
    const q = new QueryBuilder<Row>('Catalog_X', 'Europe/Moscow').filter((f) => f.A.eq(1))
    let caught: unknown
    try {
      q.filter(loose(() => undefined))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(InvalidArgumentError)
    expect(caught).toMatchObject({ argument: 'filter', received: undefined })
    expect(q.state.filter?._expr).toBe('A eq 1')
  })

  it.each([
    ['null', null],
    ['a string', 'A eq 1'],
    ['a plain object with _expr', { _expr: '1 eq 1' }],
    ['a guid() literal', guid('8af68945-1c2d-11ef-9b6a-00155d102d01')],
  ])('%s is refused too', (_, value) => {
    const q = new QueryBuilder<Row>('Catalog_X', 'Europe/Moscow')
    expect(() => q.filter(loose(() => value))).toThrow(InvalidArgumentError)
    expect(q.state.filter).toBeUndefined()
  })

  it('a filter, raw() and a boolean field are taken', () => {
    const q = new QueryBuilder<Row>('Catalog_X', 'Europe/Moscow')
    expect(q.filter((f) => f.Code.eq('x')).state.filter?._expr).toBe(`Code eq 'x'`)
    expect(q.filter(() => raw('A gt 0')).state.filter?._expr).toBe('A gt 0')
    expect(q.filter(loose((f: FieldExprMap<Row>) => f.Active)).state.filter?._expr).toBe('Active')
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
