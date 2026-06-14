import { describe, expect, it } from 'vitest'
import { InvalidArgumentError } from '../../src/errors.js'
import { QueryBuilder } from '../../src/query/builder.js'

const TZ = 'Europe/Moscow'
const g1 = '818ed18b-76c9-11e4-8918-003048663bbb'
const g2 = '818ed18b-76c9-11e4-8918-003048663ccc'

describe('QueryBuilder.whereIn', () => {
  it('builds a guid-aware OR chain for reference fields', () => {
    const q = new QueryBuilder<{ Ref_Key: string }>('Catalog_X', TZ).whereIn('Ref_Key', [g1, g2])
    expect(q.state.filter?._expr).toBe(`(Ref_Key eq guid'${g1}') or (Ref_Key eq guid'${g2}')`)
  })

  it('uses ordinary literals for non-guid values', () => {
    const q = new QueryBuilder<{ Code: string }>('Catalog_X', TZ).whereIn('Code', ['001', '002'])
    expect(q.state.filter?._expr).toBe("(Code eq '001') or (Code eq '002')")
  })

  it('AND-combines with a filter set earlier', () => {
    const q = new QueryBuilder<{ Ref_Key: string; DeletionMark: boolean }>('Catalog_X', TZ)
      .filter((f) => f.DeletionMark.eq(false))
      .whereIn('Ref_Key', [g1, g2])
    expect(q.state.filter?._expr).toBe(
      `DeletionMark eq false and ((Ref_Key eq guid'${g1}') or (Ref_Key eq guid'${g2}'))`,
    )
  })

  it('is chainable (returns this)', () => {
    const q = new QueryBuilder('Catalog_X', TZ)
    expect(q.whereIn('Ref_Key', [g1])).toBe(q)
  })

  it('throws on an empty value list', () => {
    expect(() => new QueryBuilder('Catalog_X', TZ).whereIn('Ref_Key', [])).toThrow(InvalidArgumentError)
  })
})
