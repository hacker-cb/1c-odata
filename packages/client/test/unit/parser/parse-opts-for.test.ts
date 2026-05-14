import { describe, expect, it } from 'vitest'
import { parseOptsFor } from '../../../src/parser.js'
import type { MetadataIndex } from '../../../src/validate.js'

describe('parseOptsFor', () => {
  const tz = 'Europe/Moscow'

  it('returns only serverTimezone when no metadataIndex', () => {
    expect(parseOptsFor({ serverTimezone: tz }, 'AnySet')).toEqual({ serverTimezone: tz })
  })

  it('omits typeHint when withTypeHint=false even with metadataIndex', () => {
    const idx: MetadataIndex = {
      schemaNamespace: 'StandardODATA',
      entitySetToType: { AccountingRegister_X: 'AccountingRegister_X' },
      schemas: {},
      shape: {},
    }
    expect(parseOptsFor({ serverTimezone: tz, metadataIndex: idx }, 'AccountingRegister_X', false)).toEqual({
      serverTimezone: tz,
      metadataIndex: idx,
      shape: {},
    })
  })

  it('includes typeHint when set is in entitySetToType', () => {
    const idx: MetadataIndex = {
      schemaNamespace: 'StandardODATA',
      entitySetToType: { Catalog_Items: 'Catalog_Items' },
      schemas: {},
      shape: {},
    }
    expect(parseOptsFor({ serverTimezone: tz, metadataIndex: idx }, 'Catalog_Items')).toEqual({
      serverTimezone: tz,
      typeHint: 'Catalog_Items',
      metadataIndex: idx,
      shape: {},
    })
  })

  it('omits typeHint when set is not in entitySetToType', () => {
    const idx: MetadataIndex = {
      schemaNamespace: 'StandardODATA',
      entitySetToType: {},
      schemas: {},
      shape: {},
    }
    expect(parseOptsFor({ serverTimezone: tz, metadataIndex: idx }, 'Catalog_Unknown')).toEqual({
      serverTimezone: tz,
      metadataIndex: idx,
      shape: {},
    })
  })
})
