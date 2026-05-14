import { type AuthOptions, normalizeBaseUrl } from '@1c-odata/client'
import { request } from '@1c-odata/client/internal'

export interface FetchMetadataOptions {
  baseUrl: string
  /** Materialised auth (use `connectionAuth(conn)` for Connection-driven flows). */
  auth: AuthOptions
  timeout: number
}

/**
 * Fetch `$metadata` XML from a 1С OData endpoint via Basic auth.
 *
 * Returns the raw XML body. Non-2xx responses surface as a typed `HTTPError`
 * (or one of its subclasses such as `PermissionError`) thrown from
 * `@1c-odata/client`'s transport pipeline — see `mapResponseToError`. The
 * thrown error's message includes the status code.
 */
export async function fetchMetadata(opts: FetchMetadataOptions): Promise<string> {
  const trimmedBase = normalizeBaseUrl(opts.baseUrl)
  const url = `${trimmedBase}/$metadata`
  const raw = await request(
    {
      method: 'GET',
      url,
      headers: {
        Authorization: opts.auth.header,
        Accept: 'application/xml',
      },
    },
    { timeout: opts.timeout },
  )
  return raw.body
}
