import { join, resolve } from 'node:path'
import type { CliConfig } from '@1c-odata/client'
import { connectionAuth } from '@1c-odata/client'
import { fetchMetadata } from '../fetcher.js'
import { writeOneFile } from '../writer.js'
import { pickConnections } from './_shared.js'

export interface RunFetchOptions {
  cwd: string
  config: CliConfig
  connection?: string
}

/** Run `1c-odata fetch` — download `$metadata` for one or all connections, writing each to `<metadataDir>/<connection>.xml`. */
export async function runFetch(opts: RunFetchOptions): Promise<void> {
  const metadataDir = resolve(opts.cwd, opts.config.metadataDir ?? './metadata')
  const defaultTimeout = opts.config.fetchTimeout ?? 120_000
  const connections = pickConnections(opts.config.connections, opts.connection)

  for (const [name, conn] of connections) {
    try {
      const timeout = conn.fetchTimeout ?? defaultTimeout
      const xml = await fetchMetadata({
        baseUrl: conn.baseUrl,
        auth: connectionAuth(conn),
        timeout,
      })
      await writeOneFile(join(metadataDir, `${name}.xml`), xml)
    } catch (e) {
      // Prepend the connection name in-place rather than wrapping in a new
      // Error — wrapping would lose `instanceof HTTPError`/`PermissionError`/
      // etc., breaking the STABILITY.md guarantee that library-originated
      // errors stay typed up the stack. `Error.prototype.message` is writable,
      // so subclass identity survives. Non-Error throws fall through to a
      // plain Error since there's no class to preserve.
      if (e instanceof Error) {
        if (!e.message.includes(`"${name}"`)) {
          e.message = `fetch failed for connection "${name}": ${e.message}`
        }
        throw e
      }
      // Non-Error throw — no class identity to preserve, but keep the original
      // value as `cause` so debuggers / stack-trace tooling can still reach it.
      throw new Error(`fetch failed for connection "${name}": ${String(e)}`, { cause: e })
    }
  }
}
