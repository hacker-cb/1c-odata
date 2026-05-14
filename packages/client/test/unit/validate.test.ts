import { describe, expect, it } from 'vitest'
import { type EntitySchema, ValidationError, validateEntity } from '../../src/validate.js'

const SCHEMA: EntitySchema = {
  properties: {
    Ref_Key: { type: 'Edm.Guid', nullable: false },
    Code: { type: 'Edm.String', nullable: false, maxLength: 3 },
    Description: { type: 'Edm.String', nullable: true, maxLength: 25 },
    Note: { type: 'Edm.String', nullable: true },
  },
}

describe('validateEntity', () => {
  it('returns ok for a fully-valid entity', () => {
    const r = validateEntity({ Ref_Key: '00000000-0000-0000-0000-000000000001', Code: 'USD', Description: 'd' }, SCHEMA)
    expect(r).toEqual({ ok: true })
  })

  it('flags maxLength violation', () => {
    const r = validateEntity({ Ref_Key: 'g', Code: 'TOOLONG', Description: 'd' }, SCHEMA)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.errors).toContainEqual({ kind: 'maxLength', field: 'Code', value: 'TOOLONG', max: 3 })
  })

  it('flags missing nullable:false fields', () => {
    const r = validateEntity({ Ref_Key: 'g' /* Code missing */ }, SCHEMA)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.errors).toContainEqual({ kind: 'required', field: 'Code' })
  })

  it('treats explicit null on nullable:true as valid', () => {
    const r = validateEntity({ Ref_Key: 'g', Code: 'X', Description: null }, SCHEMA)
    expect(r.ok).toBe(true)
  })

  it('ignores unknown fields (forward-compat)', () => {
    const r = validateEntity({ Ref_Key: 'g', Code: 'X', UnknownField: 'whatever' }, SCHEMA)
    expect(r.ok).toBe(true)
  })

  it('aggregates multiple errors', () => {
    const r = validateEntity({ Code: 'TOOLONG' }, SCHEMA)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.errors).toContainEqual({ kind: 'required', field: 'Ref_Key' })
    expect(r.errors).toContainEqual({ kind: 'maxLength', field: 'Code', value: 'TOOLONG', max: 3 })
  })
})

describe('ValidationError', () => {
  it('is throwable and exposes issues', () => {
    const issues = [{ kind: 'required', field: 'Code' } as const]
    const err = new ValidationError('Validation failed', { issues })
    expect(err).toBeInstanceOf(Error)
    expect(err.issues).toEqual(issues)
    expect(err.name).toBe('ValidationError')
  })
})
