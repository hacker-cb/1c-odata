/** A single EDMX `<Property>` (header column). */
export interface EdmxProperty {
  name: string
  /**
   * EDMX type literal — either `Edm.<Primitive>` or `<SchemaNs>.<TypeName>` or
   * `Collection(<inner>)`. Codegen distinguishes these forms in `type-mapper.ts`.
   */
  type: string
  nullable: boolean
  maxLength?: number
}

/** A single EDMX `<NavigationProperty>`. Target is resolved via Association. */
export interface EdmxNavigationProperty {
  name: string
  relationship: string
  fromRole: string
  toRole: string
  /**
   * Resolved by parser via Association lookup — fully qualified target type
   * (e.g. `StandardODATA.Catalog_Контрагенты`). Undefined if Association
   * cannot be resolved (treated as opaque by emitter — emitted as `unknown`).
   */
  resolvedTargetType?: string
}

/** A single EDMX `<EntityType>`. */
export interface EdmxEntityType {
  name: string
  /** PropertyRef names from `<Key>`. Single `["Ref_Key"]` for headers; composite for tabular parts / `_RecordType`. */
  key: string[]
  properties: EdmxProperty[]
  navigationProperties: EdmxNavigationProperty[]
}

/** A single EDMX `<ComplexType>` (`_RowType`, `TypeDescription`, `<X>_Balance`, …). */
export interface EdmxComplexType {
  name: string
  properties: EdmxProperty[]
}

/** A single EDMX `<EnumType>`. Unbound enum emission is deferred to Phase 7. */
export interface EdmxEnumType {
  name: string
  underlyingType: string
  members: { name: string; value?: number }[]
}

/** A single EDMX `<Association>`. */
export interface EdmxAssociation {
  name: string
  ends: { role: string; type: string; multiplicity: string }[]
}

/** A single `<EntitySet>` inside `<EntityContainer>`. */
export interface EdmxEntitySet {
  name: string
  entityType: string
}

/** A single `<Parameter>` inside a `<FunctionImport>`. */
export interface EdmxParameter {
  name: string
  type: string
  nullable: boolean
  mode?: 'In' | 'Out' | 'InOut'
}

/** A single `<FunctionImport>` inside `<EntityContainer>`. */
export interface EdmxFunctionImport {
  name: string
  httpMethod: 'GET' | 'POST'
  isBindable?: boolean
  isAlwaysBindable?: boolean
  /** Bound EntitySet name (without schema prefix). Resolved via `EntitySetPath` attribute or derived from URL pattern. */
  entitySetPath?: string
  returnType?: string
  parameters: EdmxParameter[]
}

/** `<EntityContainer>` block. */
export interface EdmxEntityContainer {
  name: string
  entitySets: EdmxEntitySet[]
  functionImports: EdmxFunctionImport[]
}

/** Root EDMX model produced by the parser. */
export interface EdmxModel {
  schemaNamespace: string
  entityTypes: EdmxEntityType[]
  complexTypes: EdmxComplexType[]
  enumTypes: EdmxEnumType[]
  associations: EdmxAssociation[]
  entityContainer: EdmxEntityContainer
}
