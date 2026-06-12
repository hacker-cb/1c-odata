import {
  type ClientOptions,
  type Connection,
  clientOptionsFromConnection,
  ODataV3Client,
  type ODataV3FunctionsBase,
} from '@1c-odata/client'
import { type FetchMetadataIndexOptions, fetchMetadataIndex } from './fetch.js'

/**
 * Options for {@link createDynamicClient}.
 *
 * @public
 */
export interface CreateDynamicClientOptions extends FetchMetadataIndexOptions {
  /**
   * Validate write payloads against the fetched schema BEFORE issuing HTTP
   * requests. Default: `false` — same as `ODataV3Client`.
   */
  validateOnWrite?: boolean
  /**
   * Runtime client options applied on top of
   * `clientOptionsFromConnection(conn)` — request timeout, retry policy,
   * hooks, umbrella abort signal.
   */
  client?: Pick<ClientOptions, 'timeout' | 'retry' | 'hooks' | 'signal'>
}

/**
 * Connect to ANY 1С base at runtime: download `$metadata`, build a
 * {@link MetadataIndex | runtime MetadataIndex}, and return a ready
 * `ODataV3Client` — full date / Int64 / ValueStorage handling and optional
 * write validation, no codegen involved.
 *
 * The schema fetch happens once, at construction. For multi-tenant servers
 * cache the index instead: `fetchMetadataIndex` + `JSON.stringify` to your
 * cache, `parseMetadataIndex` (from `@1c-odata/client`) + `new
 * ODataV3Client({ ...clientOptionsFromConnection(conn), metadataIndex })` to
 * revive.
 *
 * `TFunctions` defaults to the open-ended `ODataV3FunctionsBase`; pass a
 * codegen-emitted `Functions` interface to get typed
 * `client.functions.<Set>.<Func>()` calls when one exists.
 *
 * @example
 * ```ts
 * import { createDynamicClient } from '@1c-odata/metadata'
 *
 * const client = await createDynamicClient(
 *   {
 *     baseUrl: 'http://1c.example.com/base/odata/standard.odata',
 *     auth: { username: 'user', password: 'pass' },
 *     serverTimezone: 'Europe/Moscow',
 *   },
 *   { validateOnWrite: true },
 * )
 * const { value } = await client.query('Catalog_Валюты').top(5).get()
 * ```
 *
 * @public
 */
export async function createDynamicClient<TFunctions = ODataV3FunctionsBase>(
  conn: Connection,
  opts: CreateDynamicClientOptions = {},
): Promise<ODataV3Client<TFunctions>> {
  const { validateOnWrite, client, ...fetchOpts } = opts
  const metadataIndex = await fetchMetadataIndex(conn, fetchOpts)
  return new ODataV3Client<TFunctions>({
    ...clientOptionsFromConnection(conn),
    ...client,
    metadataIndex,
    ...(validateOnWrite !== undefined ? { validateOnWrite } : {}),
  })
}
