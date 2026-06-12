import { parseConnectionUrl } from '@1c-odata/client'
import { createDynamicClient } from '@1c-odata/metadata'

/**
 * The whole "setup": one env var, no config file, no fetch/generate step.
 * `createDynamicClient` downloads `$metadata` (10+ MB on real bases — give it
 * a few seconds on first run), builds the runtime MetadataIndex, and returns
 * a ready client with full DateTime/Int64/ValueStorage handling.
 */
export async function createClient() {
  const url = process.env.ONEC_EXAMPLE_DYNAMIC_URL
  if (!url) throw new Error('Set ONEC_EXAMPLE_DYNAMIC_URL (format: http://user:password@host/path)')

  return createDynamicClient({
    ...parseConnectionUrl(url),
    serverTimezone: 'Europe/Moscow',
  })
}
