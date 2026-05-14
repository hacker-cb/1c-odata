// packages/client/src/index.ts
export type { AuthOptions, BasicAuthOptions } from './auth/basic.js'
export { BasicAuth } from './auth/basic.js'
export type { ClientOptions, MutationOptions, RequestOptions, RetryPolicy } from './client/options.js'
// V3 client + handles
export { ODataV3Client, type ODataV3ClientOptions } from './client/v3-client.js'
export { V3DocumentHandle, V3EntityHandle, V3EntitySetHandle } from './client/v3-handles.js'
export { V3QueryBuilder } from './client/v3-query.js'
export type { CliConfig, Connection, DataShape } from './connection.js'
export { connectionAuth, defineConfig, parseConnectionUrl, validateConnection } from './connection.js'
export type {
  ErrorFormat,
  HTTPErrorOptions,
  InvalidArgumentErrorOptions,
  ODataErrorBody,
  ODataErrorOptions,
  TimeoutErrorOptions,
} from './errors.js'
export {
  BusinessError,
  ConcurrencyError,
  HTTPError,
  InvalidArgumentError,
  NetworkError,
  ODataError,
  ParseError,
  PermissionError,
  TimeoutError,
} from './errors.js'
export { toFilterString } from './filter.js'
export type { ODataV3FunctionsBase, WithInstanceRef } from './functions.js'
export type { ConsoleHookOptions } from './hooks/console.js'
export { consoleHook } from './hooks/console.js'
export type { RequestEvent, RequestHooks, ResponseEvent } from './hooks/types.js'
export { mapResponseToError } from './http/error-mapping.js'
export { loadMetadataIndex } from './load-metadata-index.js'
export type { QueryState } from './query/builder.js'
export { QueryBuilder } from './query/builder.js'
export type { FieldExpr, FieldExprMap, FilterExpression } from './query/filter-internal.js'
export {
  type BalanceArgs,
  type DrCrTurnoversArgs,
  type ExtDimensionsArgs,
  type RecordsWithExtDimensionsArgs,
  RegisterHelper,
  type SliceArgs,
  type TurnoversArgs,
} from './register.js'
export { clientOptionsFromConnection } from './runtime.js'
export { formatInZone, parseInZone } from './timezone.js'
export type { Entity, Guid, ValueStorage } from './types/core.js'
export { EMPTY_GUID, ONEC_EMPTY_DATE } from './types/core.js'
export type { EntityKey } from './url-builder.js'
export { normalizeBaseUrl } from './url-builder.js'
export type {
  EntitySchema,
  MetadataIndex,
  PropertySchema,
  ValidationErrorOptions,
  ValidationIssue,
  ValidationResult,
} from './validate.js'
export { ValidationError, validateEntity } from './validate.js'
export type { ReadStreamResult, WriteStreamInput } from './value-storage.js'
