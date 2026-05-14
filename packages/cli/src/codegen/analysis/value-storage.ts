import type { EdmxComplexType, EdmxEntityType, EdmxProperty } from '../parser/ast.js'

/**
 * Detect ValueStorage base names — `ХранилищеЗначения` reqs in 1C surface as a
 * triple of properties: `<X>: Edm.Stream` + `<X>_Base64Data: Edm.Binary` + `<X>_Type: Edm.String`.
 * See spec §4.8 + §5.3.
 */
export function detectValueStorage(entity: EdmxEntityType | EdmxComplexType): Set<string> {
  const byName = new Map<string, EdmxProperty>(entity.properties.map((p) => [p.name, p]))
  const out = new Set<string>()
  for (const p of entity.properties) {
    if (p.type !== 'Edm.Stream') continue
    const b64 = byName.get(`${p.name}_Base64Data`)
    const tp = byName.get(`${p.name}_Type`)
    if (b64?.type === 'Edm.Binary' && tp?.type === 'Edm.String') out.add(p.name)
  }
  return out
}
