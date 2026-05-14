import type { ODataError } from '../errors.js'
import type { RequestEvent, RequestHooks, ResponseEvent } from './types.js'

export interface ConsoleHookOptions {
  /** Include body (truncated) in output. Default: false. */
  logBodies?: boolean
  /** Truncate bodies to this many characters. Default: 2000. */
  maxBodyChars?: number
  /** Custom write function (default: process.stderr.write). Useful for tests + redirecting to logger. */
  writeFn?: (line: string) => void
}

/**
 * Built-in helper hooks that print formatted request/response/error lines to
 * stderr. Useful for ad-hoc debugging — for production logging integrate with
 * pino/sentry/OTel via custom RequestHooks.
 *
 * @example
 * ```
 * new ODataV3Client({ ..., hooks: consoleHook({ logBodies: true }) })
 * // stderr:
 * // [1c-odata] → GET /Catalog_X?$top=10
 * // [1c-odata] ← 200 127ms 5.3KB
 * ```
 *
 * @public
 */
export function consoleHook(opts: ConsoleHookOptions = {}): RequestHooks {
  const maxBody = opts.maxBodyChars ?? 2000
  const write =
    opts.writeFn ??
    ((s: string) => {
      process.stderr.write(s)
    })

  return {
    beforeRequest: (req: RequestEvent) => {
      const path = stripBase(req.url)
      let line = `[1c-odata] → ${req.method} ${path}\n`
      if (opts.logBodies && req.body) line += `[1c-odata]   body: ${truncate(req.body, maxBody)}\n`
      write(line)
    },
    afterResponse: (_req: RequestEvent, res: ResponseEvent) => {
      const sizeKb = res.body ? (res.body.length / 1024).toFixed(1) : '0'
      let line = `[1c-odata] ← ${res.status} ${res.durationMs}ms ${sizeKb}KB\n`
      if (opts.logBodies && res.body) line += `[1c-odata]   body: ${truncate(res.body, maxBody)}\n`
      write(line)
    },
    onError: (_req: RequestEvent, err: ODataError) => {
      const e = err as ODataError & { status?: number; code?: string }
      const status = e.status !== undefined ? `${e.status} ` : ''
      const code = e.code !== undefined ? `code="${e.code}" ` : ''
      write(`[1c-odata] ✗ ${err.name} ${status}${code}${err.message}\n`)
    },
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}… (${s.length - max} more chars)`
}

function stripBase(url: string): string {
  // Show only path + query for brevity
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}`
  } catch {
    return url
  }
}
