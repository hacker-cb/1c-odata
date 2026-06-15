// packages/client/src/concurrency.ts

import type { TransportClient } from './client/contract.js'
import type { RequestOptions } from './client/options.js'
import { ConcurrencyError } from './errors.js'
import { parseV3Single } from './parser.js'
import { buildV3KeyUrl, type EntityKey } from './url-builder.js'

/**
 * Pre-mutation concurrency guard. Issues a GET against the entity, compares
 * `DataVersion`, and throws `ConcurrencyError` if it differs from the expected
 * value. Called by `V3EntityHandle` mutation methods when `MutationOptions.expectVersion`
 * is set.
 *
 * Spec §2.5: 1С silently ignores the `If-Match` header, so optimistic
 * concurrency must be enforced client-side. We synthesise a 412-shaped
 * `ConcurrencyError` even though no HTTP call actually returned 412 — hence
 * `errorFormat: 'none'` and no `odata` envelope (there was no server response);
 * `request` points at the guard's own GET.
 *
 * @internal
 */
export async function assertExpectedVersion(
  client: TransportClient,
  entitySet: string,
  key: EntityKey,
  expected: string,
  opts: RequestOptions,
): Promise<void> {
  const url = buildV3KeyUrl(client.baseUrl, entitySet, key)
  const raw = await client.transportGet(url, opts)
  const fresh = parseV3Single<{ DataVersion?: string }>(raw.body, { serverTimezone: client.serverTimezone })
  if (fresh.DataVersion !== expected) {
    const detail = `expectVersion mismatch: got DataVersion=${JSON.stringify(fresh.DataVersion)}, expected ${JSON.stringify(expected)}`
    throw new ConcurrencyError(`HTTP 412 Precondition Failed: ${detail}`, {
      status: 412,
      statusText: 'Precondition Failed',
      errorFormat: 'none',
      request: { method: 'GET', url },
    })
  }
}
