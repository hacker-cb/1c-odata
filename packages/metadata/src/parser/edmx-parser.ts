import { XMLParser } from 'fast-xml-parser'
import type {
  EdmxAssociation,
  EdmxComplexType,
  EdmxEntityContainer,
  EdmxEntitySet,
  EdmxEntityType,
  EdmxEnumType,
  EdmxFunctionImport,
  EdmxModel,
  EdmxNavigationProperty,
  EdmxParameter,
  EdmxProperty,
} from './ast.js'

function readProperty(raw: Record<string, unknown>): EdmxProperty {
  const nameRaw = raw['@_Name']
  if (typeof nameRaw !== 'string' || nameRaw.length === 0) {
    throw new Error('<Property> missing or empty Name attribute')
  }
  const name = nameRaw
  const typeRaw = raw['@_Type']
  if (typeof typeRaw !== 'string' || typeRaw.length === 0) {
    throw new Error(`<Property Name="${name}"> missing or empty Type attribute`)
  }
  const type = typeRaw
  const nullable = raw['@_Nullable'] !== 'false' // EDMX default is true
  const maxLengthRaw = raw['@_MaxLength']
  const out: EdmxProperty = { name, type, nullable }
  if (typeof maxLengthRaw === 'string' && /^\d+$/.test(maxLengthRaw)) {
    out.maxLength = Number.parseInt(maxLengthRaw, 10)
  }
  return out
}

function readNavigationProperty(raw: Record<string, unknown>): EdmxNavigationProperty {
  return {
    name: String(raw['@_Name']),
    relationship: String(raw['@_Relationship']),
    fromRole: String(raw['@_FromRole']),
    toRole: String(raw['@_ToRole']),
  }
}

function readEntityType(raw: Record<string, unknown>): EdmxEntityType {
  const name = String(raw['@_Name'])
  const keyBlock = raw.Key as Record<string, unknown> | undefined
  const propRefs = (keyBlock?.PropertyRef as Record<string, unknown>[] | undefined) ?? []
  const key = propRefs.map((p) => String(p['@_Name']))
  const props = (raw.Property as Record<string, unknown>[] | undefined) ?? []
  const navs = (raw.NavigationProperty as Record<string, unknown>[] | undefined) ?? []
  return {
    name,
    key,
    properties: props.map(readProperty),
    navigationProperties: navs.map(readNavigationProperty),
  }
}

function readComplexType(raw: Record<string, unknown>): EdmxComplexType {
  const props = (raw.Property as Record<string, unknown>[] | undefined) ?? []
  return {
    name: String(raw['@_Name']),
    properties: props.map(readProperty),
  }
}

function readEntitySet(raw: Record<string, unknown>): EdmxEntitySet {
  return {
    name: String(raw['@_Name']),
    entityType: String(raw['@_EntityType']),
  }
}

function readParameter(raw: Record<string, unknown>): EdmxParameter {
  const nameRaw = raw['@_Name']
  if (typeof nameRaw !== 'string' || nameRaw.length === 0) {
    throw new Error('<Parameter> missing or empty Name attribute')
  }
  const typeRaw = raw['@_Type']
  if (typeof typeRaw !== 'string' || typeRaw.length === 0) {
    throw new Error(`<Parameter Name="${nameRaw}"> missing or empty Type attribute`)
  }
  const modeRaw = raw['@_Mode']
  const out: EdmxParameter = {
    name: nameRaw,
    type: typeRaw,
    nullable: raw['@_Nullable'] !== 'false',
  }
  if (modeRaw === 'In' || modeRaw === 'Out' || modeRaw === 'InOut') out.mode = modeRaw
  return out
}

function readFunctionImport(raw: Record<string, unknown>, schemaNs: string): EdmxFunctionImport {
  // 1C/EDMX V3 quirk: write FIs (Post/Unpost/…) often omit `m:HttpMethod` entirely.
  // Spec §4.5: any FI marked `IsSideEffecting="true"` (or implicit by name) is POST;
  // GET is the default for read FIs. Defaulting to POST when both `m:HttpMethod`
  // and `IsSideEffecting` are absent would over-classify, so keep GET as fallback
  // and explicitly upgrade to POST if `IsSideEffecting="true"`.
  const httpMethodRaw = raw['@_m:HttpMethod'] ?? raw['@_HttpMethod']
  let httpMethod: 'GET' | 'POST' = 'GET'
  if (typeof httpMethodRaw === 'string') {
    httpMethod = httpMethodRaw.toUpperCase() === 'POST' ? 'POST' : 'GET'
  } else if (raw['@_IsSideEffecting'] === 'true') {
    httpMethod = 'POST'
  }
  const params = (raw.Parameter as Record<string, unknown>[] | undefined) ?? []
  const parameters = params.map(readParameter)
  const out: EdmxFunctionImport = {
    name: String(raw['@_Name']),
    httpMethod,
    parameters,
  }
  if (raw['@_IsBindable'] === 'true') out.isBindable = true
  if (raw['@_IsAlwaysBindable'] === 'true') out.isAlwaysBindable = true
  // EntitySetPath sources, in order of precedence:
  //   1. Explicit `EntitySetPath` attribute (synthetic fixtures, EDMX V4)
  //   2. The `bindingParameter` Parameter's Type — `<Schema>.<EntitySet>` (1C V3 real-world)
  // Both paths produce the bare EntitySet name without schema prefix.
  if (typeof raw['@_EntitySetPath'] === 'string') {
    out.entitySetPath = String(raw['@_EntitySetPath'])
  } else {
    const binding = parameters.find((p) => p.name === 'bindingParameter')
    if (binding) {
      const t = binding.type
      const collMatch = /^Collection\((.+)\)$/.exec(t)
      const inner = collMatch?.[1] ?? t
      const prefix = `${schemaNs}.`
      const bare = inner.startsWith(prefix) ? inner.slice(prefix.length) : inner
      if (bare.length > 0 && !bare.startsWith('Edm.')) out.entitySetPath = bare
    }
  }
  if (typeof raw['@_ReturnType'] === 'string') out.returnType = String(raw['@_ReturnType'])
  return out
}

function readAssociation(raw: Record<string, unknown>): EdmxAssociation {
  const ends = (raw.End as Record<string, unknown>[] | undefined) ?? []
  return {
    name: String(raw['@_Name']),
    ends: ends.map((e) => ({
      role: String(e['@_Role']),
      type: String(e['@_Type']),
      multiplicity: String(e['@_Multiplicity']),
    })),
  }
}

function readEntityContainer(raw: Record<string, unknown> | undefined, schemaNs: string): EdmxEntityContainer {
  if (!raw) return { name: '', entitySets: [], functionImports: [] }
  const sets = (raw.EntitySet as Record<string, unknown>[] | undefined) ?? []
  const fis = (raw.FunctionImport as Record<string, unknown>[] | undefined) ?? []
  return {
    name: String(raw['@_Name'] ?? ''),
    entitySets: sets.map(readEntitySet),
    functionImports: fis.map((fi) => readFunctionImport(fi, schemaNs)),
  }
}

function readEnumType(raw: Record<string, unknown>): EdmxEnumType {
  const members = (raw.Member as Record<string, unknown>[] | undefined) ?? []
  return {
    name: String(raw['@_Name']),
    underlyingType: String(raw['@_UnderlyingType'] ?? 'Edm.Int32'),
    members: members.map((m) => {
      const valRaw = m['@_Value']
      const member: { name: string; value?: number } = { name: String(m['@_Name']) }
      if (typeof valRaw === 'string' && /^-?\d+$/.test(valRaw)) {
        member.value = Number.parseInt(valRaw, 10)
      }
      return member
    }),
  }
}

/**
 * Parse a 1C OData V3 EDMX XML document into an `EdmxModel`.
 *
 * 1C platform always emits a single `<Schema>` element with `Namespace="StandardODATA"`.
 * Throws on malformed XML, missing `<Schema>`, or multiple `<Schema>` elements.
 */
export function parseEdmx(xml: string): EdmxModel {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    // Some EDMX collections appear as a single child for tiny fixtures; force arrays
    // for every collection-shaped element so the parser output is uniform.
    isArray: (name) =>
      [
        'Schema',
        'EntityType',
        'ComplexType',
        'EnumType',
        'Association',
        'EntityContainer',
        'EntitySet',
        'FunctionImport',
        'Property',
        'NavigationProperty',
        'PropertyRef',
        'End',
        'Member',
        'Parameter',
      ].includes(name),
    // Preserve attribute values as strings — we coerce types in our own code.
    parseAttributeValue: false,
    trimValues: true,
  })
  let parsed: unknown
  try {
    parsed = parser.parse(xml)
  } catch (e) {
    throw new Error(`Failed to parse EDMX XML: ${(e as Error).message}`)
  }
  const root = (parsed as Record<string, unknown>)['edmx:Edmx']
  if (!root || typeof root !== 'object') {
    throw new Error('Expected <edmx:Edmx> root element')
  }
  const dataServices = (root as Record<string, unknown>)['edmx:DataServices']
  if (dataServices === undefined || dataServices === null) {
    throw new Error('Expected <edmx:DataServices> child containing a <Schema>')
  }
  const schemas = typeof dataServices === 'object' ? (dataServices as Record<string, unknown>).Schema : undefined
  if (!Array.isArray(schemas) || schemas.length === 0) {
    throw new Error('Expected at least one <Schema> element inside <edmx:DataServices>')
  }
  if (schemas.length > 1) {
    throw new Error(`Expected exactly 1 <Schema>, got ${schemas.length}`)
  }
  const schema = schemas[0] as Record<string, unknown>
  const ns = schema['@_Namespace']
  if (typeof ns !== 'string' || ns.length === 0) {
    throw new Error('Expected <Schema Namespace="..."> attribute')
  }
  const rawEntityTypes = (schema.EntityType as Record<string, unknown>[] | undefined) ?? []
  const entityTypes = rawEntityTypes.map(readEntityType)
  const rawComplex = (schema.ComplexType as Record<string, unknown>[] | undefined) ?? []
  const rawEnums = (schema.EnumType as Record<string, unknown>[] | undefined) ?? []
  const complexTypes = rawComplex.map(readComplexType)
  const enumTypes = rawEnums.map(readEnumType)

  const rawAssoc = (schema.Association as Record<string, unknown>[] | undefined) ?? []
  const associations = rawAssoc.map(readAssociation)

  const rawContainers = (schema.EntityContainer as Record<string, unknown>[] | undefined) ?? []
  const entityContainer = readEntityContainer(rawContainers[0], ns)

  // Resolve NavigationProperty.resolvedTargetType via Association lookup
  const assocByName = new Map(associations.map((a) => [a.name, a]))
  for (const et of entityTypes) {
    for (const np of et.navigationProperties) {
      // relationship attribute is `<Schema>.<AssocName>` — strip the schema prefix
      const lastDot = np.relationship.lastIndexOf('.')
      const assocName = lastDot >= 0 ? np.relationship.slice(lastDot + 1) : np.relationship
      const assoc = assocByName.get(assocName)
      const target = assoc?.ends.find((e) => e.role === np.toRole)
      if (target) np.resolvedTargetType = target.type
    }
  }

  return {
    schemaNamespace: ns,
    entityTypes,
    complexTypes,
    enumTypes,
    associations,
    entityContainer,
  }
}
