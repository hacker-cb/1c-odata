// packages/client/src/internal.ts
/**
 * Internal subpath: cross-package escape hatch for `@1c-odata/cli` and
 * integration tests.
 *
 * Symbols re-exported here are NOT semver-stable. Minor releases MAY break
 * them. End-user code should never import from `@1c-odata/client/internal`.
 *
 * See `STABILITY.md` for the boundary policy.
 */

export { requestWithRetry } from './http/retry.js'
export type { RawResponse, RequestConfig, StreamResponse, TransportOptions } from './http/transport.js'
export { request, requestStream } from './http/transport.js'
export type { CollectionResult } from './parser.js'
