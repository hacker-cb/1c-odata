import type { EdmxEntityType } from '../parser/ast.js'

/**
 * Link tabular EntityTypes to their header parents.
 *
 * Two distinct cases — both produce the same `headerToTabulars` / `tabularToHeader` view,
 * but identified by different EDMX shape rules:
 *
 *   1. Document/Catalog tabular sections (`<Header>_<Tabular>`) — composite-key children
 *      whose parent is a single-key (`["Ref_Key"]`) header. Identified by longest-prefix
 *      name match. See spec §2.2.
 *
 *   2. Register `_RecordType` companions (`<Register>_RecordType`) — 1С record-shape
 *      variant of a register parent. Always linked to its `<Register>` parent regardless
 *      of either entity's key length: register parents have composite keys
 *      (e.g. `["Recorder", "Recorder_Type"]`) and the `_RecordType` companion has its
 *      own composite key shape (`["Recorder", "LineNumber", "Recorder_Type"]` for AR,
 *      `["Period", "<Dim>_Key"]` for IR). Standalone `_RecordType` files would leak
 *      ~100 spurious headers vs spec §2.2 counts.
 */
export function linkTabularParts(entities: EdmxEntityType[]): {
  headerToTabulars: Map<string, string[]>
  tabularToHeader: Map<string, string>
} {
  const byName = new Map<string, EdmxEntityType>(entities.map((e) => [e.name, e]))
  const headerToTabulars = new Map<string, string[]>()
  const tabularToHeader = new Map<string, string>()
  for (const e of entities) {
    // Case 2: 1С `_RecordType` companion. Link unconditionally to `<X>` when present.
    if (e.name.endsWith('_RecordType')) {
      const parentName = e.name.slice(0, -'_RecordType'.length)
      if (byName.has(parentName)) {
        const list = headerToTabulars.get(parentName) ?? []
        list.push(e.name)
        headerToTabulars.set(parentName, list)
        tabularToHeader.set(e.name, parentName)
      }
      continue
    }
    // Case 1: regular tabular — child has composite key; parent is a single-key header.
    if (e.key.length <= 1) continue
    // Find the longest prefix that is itself a known EntityType.
    const parts = e.name.split('_')
    for (let i = parts.length - 1; i >= 1; i--) {
      const candidate = parts.slice(0, i).join('_')
      if (!byName.has(candidate)) continue
      const parent = byName.get(candidate)!
      if (parent.key.length !== 1) continue // parent must be a header
      const existing = headerToTabulars.get(candidate) ?? []
      existing.push(e.name)
      headerToTabulars.set(candidate, existing)
      tabularToHeader.set(e.name, candidate)
      break
    }
  }
  return { headerToTabulars, tabularToHeader }
}
