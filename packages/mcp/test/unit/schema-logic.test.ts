import type { MetadataIndex } from '@1c-odata/client'
import type { EdmxModel } from '@1c-odata/metadata'
import { describe, expect, it } from 'vitest'
import { describeEntity } from '../../src/tools/schema-logic.js'

// Minimal index/edmx with intentionally plain-object maps (as built by
// @1c-odata/metadata), so prototype-chain keys are reachable if not guarded.
const index = { schemas: {}, entitySetToType: {} } as unknown as MetadataIndex
const edmx = { entityTypes: [] } as unknown as EdmxModel

describe('describeEntity', () => {
  it('throws "Unknown entity" for a name that is in neither map', () => {
    expect(() => describeEntity(index, edmx, 'Catalog_DoesNotExist')).toThrow(/Unknown entity/)
  })

  it('rejects prototype-chain keys instead of resolving them as entities', () => {
    // Without own-key guards, `index.entitySetToType["__proto__"]` resolves up the
    // prototype chain to a non-string and crashes classifyEntity/tailName. These
    // must be treated like any other unknown name.
    for (const evil of ['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf']) {
      expect(() => describeEntity(index, edmx, evil)).toThrow(/Unknown entity/)
    }
  })
})
