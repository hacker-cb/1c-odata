// @1c-odata/metadata — 1С OData V3 schema toolkit.
//
// EDMX ($metadata) parsing, schema analysis, and runtime MetadataIndex
// building. Consumed by @1c-odata/cli for codegen and usable directly to run
// @1c-odata/client against any base at runtime (no generated files).

// ── error types (re-exported from @1c-odata/client so consumers can catch
//    metadata/EDMX failures without a separate client import) ──
export { MetadataError, ODataError } from '@1c-odata/client'
// ── schema analysis ──
export { type ClosureAddition, type ClosureResult, computeClosure } from './analysis/closure.js'
export { groupFunctionImportsByEntitySet } from './analysis/function-bindings.js'
export { linkTabularParts } from './analysis/tabular-parts.js'
export { detectValueStorage } from './analysis/value-storage.js'
// ── runtime client ──
export { type CreateDynamicClientOptions, createDynamicClient } from './dynamic-client.js'
// ── $metadata download ──
export {
  type FetchMetadataIndexOptions,
  type FetchMetadataXmlOptions,
  fetchMetadataIndex,
  fetchMetadataXml,
} from './fetch.js'
// ── runtime MetadataIndex building ──
export { type BuildMetadataIndexOptions, buildMetadataIndex } from './index-builder.js'
export type {
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
} from './parser/ast.js'
// ── 1С entity-kind classification ──
export { classifyEntity, KIND_ORDER, KIND_TO_FOLDER, type Kind, tailName } from './parser/classifier.js'
// ── EDMX parsing ──
export { parseEdmx } from './parser/edmx-parser.js'
