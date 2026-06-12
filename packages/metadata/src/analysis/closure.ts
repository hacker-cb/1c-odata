import type { EdmxFunctionImport, EdmxModel } from '../parser/ast.js'

export interface ClosureAddition {
  kind: 'entity' | 'complex' | 'function'
  name: string
  /** Human-readable reason — e.g. `"Catalog_X.Контрагент"` or `"tabular of Document_РТУ"`. */
  reason: string
}

export interface ClosureResult {
  entities: Set<string>
  complexTypes: Set<string>
  functionImports: EdmxFunctionImport[]
  /**
   * Direct seed-matched names (subset of `entities`). When no filter was
   * applied (`include` undefined or empty), `seed.size === model.entityTypes.length`;
   * the closure walk uses that equality as a sentinel (see the `noFilter`
   * check in `computeClosure`) to also include orphan ComplexTypes.
   */
  seed: Set<string>
  /** Added via closure (entities ∪ complexTypes minus seed). */
  additions: ClosureAddition[]
}

/**
 * Compute transitive closure of `seed` filter. Walks NavProp targets,
 * tabular children, _RecordType companions, ComplexTypes referenced via
 * Property.type / Collection(<T>), FunctionImports bound to kept
 * EntitySets and their return-type ComplexTypes. Iterates to fixed point.
 */
export function computeClosure(model: EdmxModel, filter: (name: string) => boolean): ClosureResult {
  const entityByName = new Map(model.entityTypes.map((e) => [e.name, e]))
  const complexByName = new Map(model.complexTypes.map((c) => [c.name, c]))
  const fisByEntitySet = new Map<string, EdmxFunctionImport[]>()
  for (const fi of model.entityContainer.functionImports) {
    const k = fi.entitySetPath ?? ''
    const list = fisByEntitySet.get(k) ?? []
    list.push(fi)
    fisByEntitySet.set(k, list)
  }

  const entities = new Set<string>()
  const complexTypes = new Set<string>()
  const seed = new Set<string>()
  const additions: ClosureAddition[] = []

  for (const e of model.entityTypes) {
    if (filter(e.name)) {
      entities.add(e.name)
      seed.add(e.name)
    }
  }

  const stripPrefix = (t: string): string | null => {
    const prefix = `${model.schemaNamespace}.`
    if (t.startsWith(prefix)) return t.slice(prefix.length)
    return null
  }
  const innerOfCollection = (t: string): string => {
    const m = /^Collection\((.+)\)$/.exec(t)
    return m ? m[1]! : t
  }

  let changed = true
  while (changed) {
    changed = false

    for (const eName of [...entities]) {
      const e = entityByName.get(eName)
      if (!e) continue

      for (const np of e.navigationProperties) {
        if (!np.resolvedTargetType) continue
        const target = stripPrefix(np.resolvedTargetType)
        if (target === null) continue
        if (!entities.has(target) && entityByName.has(target)) {
          entities.add(target)
          additions.push({ kind: 'entity', name: target, reason: `${eName}.${np.name}` })
          changed = true
        }
      }

      for (const p of e.properties) {
        const inner = stripPrefix(innerOfCollection(p.type))
        if (inner === null) continue
        if (entityByName.has(inner) && !entities.has(inner)) {
          entities.add(inner)
          additions.push({ kind: 'entity', name: inner, reason: `${eName}.${p.name}` })
          changed = true
        }
        if (complexByName.has(inner) && !complexTypes.has(inner)) {
          complexTypes.add(inner)
          additions.push({ kind: 'complex', name: inner, reason: `${eName}.${p.name}` })
          changed = true
        }
      }
    }

    // Tabular children + _RecordType companions
    for (const e of model.entityTypes) {
      if (entities.has(e.name)) continue
      if (e.name.endsWith('_RecordType')) {
        const parent = e.name.slice(0, -'_RecordType'.length)
        if (entities.has(parent)) {
          entities.add(e.name)
          additions.push({ kind: 'entity', name: e.name, reason: `_RecordType companion of ${parent}` })
          changed = true
          continue
        }
      }
      if (e.key.length > 1) {
        const parts = e.name.split('_')
        for (let i = parts.length - 1; i >= 1; i--) {
          const candidate = parts.slice(0, i).join('_')
          if (!entities.has(candidate)) continue
          const parent = entityByName.get(candidate)
          if (!parent || parent.key.length !== 1) continue
          entities.add(e.name)
          additions.push({ kind: 'entity', name: e.name, reason: `tabular of ${candidate}` })
          changed = true
          break
        }
      }
    }

    // ComplexType property walk
    for (const cName of [...complexTypes]) {
      const ct = complexByName.get(cName)
      if (!ct) continue
      for (const p of ct.properties) {
        const inner = stripPrefix(innerOfCollection(p.type))
        if (inner === null) continue
        if (entityByName.has(inner) && !entities.has(inner)) {
          entities.add(inner)
          additions.push({ kind: 'entity', name: inner, reason: `${cName}.${p.name}` })
          changed = true
        }
        if (complexByName.has(inner) && !complexTypes.has(inner)) {
          complexTypes.add(inner)
          additions.push({ kind: 'complex', name: inner, reason: `${cName}.${p.name}` })
          changed = true
        }
      }
    }
  }

  // FIs bound to kept EntitySets + their return types
  const functionImports: EdmxFunctionImport[] = []
  for (const eName of entities) {
    const fis = fisByEntitySet.get(eName) ?? []
    for (const fi of fis) {
      functionImports.push(fi)
      if (fi.returnType) {
        const inner = stripPrefix(innerOfCollection(fi.returnType))
        if (inner !== null && complexByName.has(inner) && !complexTypes.has(inner)) {
          complexTypes.add(inner)
          additions.push({ kind: 'complex', name: inner, reason: `${eName}.${fi.name} return type` })
        }
      }
    }
  }

  // When no filter is active (all entities seeded, or no entities at all), include every
  // ComplexType — "orphan" types not reachable via property/FI walks must still be emitted
  // because the user expects the full schema output.
  const noFilter = model.entityTypes.length === 0 || seed.size === model.entityTypes.length
  if (noFilter) {
    for (const [name] of complexByName) {
      if (!complexTypes.has(name)) {
        complexTypes.add(name)
        // Not an "addition" — it's always been part of the full model; no reason entry needed.
      }
    }
  }

  return { entities, complexTypes, functionImports, seed, additions }
}
