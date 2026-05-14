import { EMPTY_GUID, type Entity, type Guid, ONEC_EMPTY_DATE, type ValueStorage } from '@1c-odata/client'
import { describe, expect, it } from 'vitest'

describe('core type constants', () => {
  it('EMPTY_GUID matches 1C empty reference', () => {
    expect(EMPTY_GUID).toBe('00000000-0000-0000-0000-000000000000')
  })

  it('ONEC_EMPTY_DATE matches 1C default datetime', () => {
    expect(ONEC_EMPTY_DATE).toBe('0001-01-01T00:00:00')
  })

  it('Guid is a template-literal-typed string', () => {
    const id: Guid = '818ed18b-76c9-11e4-8918-003048663bbb'
    expect(typeof id).toBe('string')
  })
})

describe('core entity interfaces', () => {
  it('Entity has 1C system fields', () => {
    const e: Entity = {
      Ref_Key: '818ed18b-76c9-11e4-8918-003048663bbb',
      DataVersion: 'AAAAAQAAAAA=',
      DeletionMark: false,
      Predefined: false,
      PredefinedDataName: '',
    }
    expect(e.Ref_Key).toMatch(/^[0-9a-f-]+$/i)
  })

  it('ValueStorage exposes contentType + base64Data', () => {
    const v: ValueStorage = {
      contentType: 'image/jpeg',
      base64Data: 'iVBORw0KGgoAAAANSUhEUgAA',
    }
    expect(v.contentType).toBe('image/jpeg')
    expect(v.base64Data.length).toBeGreaterThan(0)
  })
})
