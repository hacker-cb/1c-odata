import { describe, expect, it } from 'vitest'
import { and } from '../../src/filter.js'
import { QueryBuilder } from '../../src/query/builder.js'

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
