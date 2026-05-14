import type { RequestOptions } from './options.js'

/**
 * Narrow capability surface of an OData client used by helpers like
 * `concurrency.ts`, `value-storage.ts`, and any other module that performs
 * raw transport calls. Decouples helpers from the concrete `ODataV3Client`
 * class so they can be tested with minimal mocks and so the helper layer
 * does not become a circular dependency partner of the client class.
 *
 * Subset deliberately omitted (not used by current helpers): `transportPost`,
 * `transportPut`, `transportDelete`, `transportFetch`. Add as needed.
 *
 * @internal
 */
export interface TransportClient {
  readonly baseUrl: string
  readonly serverTimezone: string
  transportGet(url: string, callOpts: RequestOptions): Promise<{ body: string; status: number }>
  transportPatch(
    url: string,
    body: unknown,
    callOpts: RequestOptions,
    entitySet: string,
    extraHeaders?: Record<string, string>,
  ): Promise<{ body: string; status: number }>
  transportStream(url: string, callOpts: RequestOptions): Promise<Response>
}
