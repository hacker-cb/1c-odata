import { join, resolve } from 'node:path'
import { connectionAuth } from '@1c-odata/client'
import { fetchMetadataXml } from '@1c-odata/metadata'
import { mapWithConcurrency } from '../concurrency.js'
import type { CodegenConfig } from '../config.js'
import { writeOneFile } from '../writer.js'
import { pickTargets } from './_shared.js'

/**
 * Max concurrent `$metadata` downloads. The downloads are independent network
 * I/O, so overlap them; the cap keeps a config with many bases from opening
 * dozens of 10+ MB transfers at once.
 */
const FETCH_CONCURRENCY = 4

export interface RunFetchOptions {
  cwd: string
  config: CodegenConfig
  target?: string
}

/** Run `1c-odata fetch` — download `$metadata` for one or all targets, writing each to `<metadataDir>/<target>.xml`. */
export async function runFetch(opts: RunFetchOptions): Promise<void> {
  const metadataDir = resolve(opts.cwd, opts.config.metadataDir ?? './metadata')
  const defaultTimeout = opts.config.fetchTimeout ?? 120_000
  const targets = pickTargets(opts.config.targets, opts.target)

  // Download targets concurrently (bounded). A base's `$metadata` is 10+ MB /
  // several seconds, so a serial loop would pay the sum of every base's
  // latency; overlapping cuts the wall-clock to ~the slowest single base.
  // Each worker records its own failure instead of rejecting: that keeps the
  // run best-effort (a `Promise.all` rejection would fail-fast and skip targets
  // still in flight) and lets us rethrow the first failure in *target* order
  // rather than whichever download happened to settle first — matching the
  // serial loop, which surfaced the earliest target's failure.
  const errors: unknown[] = []
  await mapWithConcurrency(targets, FETCH_CONCURRENCY, async ([name, target], index) => {
    try {
      const xml = await fetchMetadataXml({
        baseUrl: target.connection.baseUrl,
        auth: connectionAuth(target.connection),
        timeout: target.fetchTimeout ?? defaultTimeout,
      })
      await writeOneFile(join(metadataDir, `${name}.xml`), xml)
    } catch (e) {
      errors[index] = prefixTargetError(name, e)
    }
  })

  const firstError = errors.find((e) => e !== undefined)
  if (firstError !== undefined) throw firstError
}

/**
 * Tag an error with the failing target's name. Mutates an `Error`'s message
 * in-place rather than wrapping — wrapping would lose `instanceof HTTPError` /
 * `PermissionError` / etc., breaking the STABILITY.md guarantee that
 * library-originated errors stay typed up the stack (`Error.prototype.message`
 * is writable, so subclass identity survives). A non-Error throw has no class
 * identity to preserve, so it is wrapped with the original kept as `cause`.
 */
function prefixTargetError(name: string, e: unknown): unknown {
  if (e instanceof Error) {
    if (!e.message.includes(`"${name}"`)) {
      e.message = `fetch failed for target "${name}": ${e.message}`
    }
    return e
  }
  return new Error(`fetch failed for target "${name}": ${String(e)}`, { cause: e })
}
