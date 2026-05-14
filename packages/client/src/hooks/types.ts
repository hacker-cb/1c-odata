import type { ODataError } from '../errors.js'

/**
 * Wire-level snapshot of the outgoing request, given to `beforeRequest` and
 * passed back into `afterResponse` / `onError`.
 * @public
 */
export interface RequestEvent {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  url: string
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
}

/**
 * Wire-level snapshot of the incoming response.
 * @public
 */
export interface ResponseEvent {
  status: number
  statusText: string
  headers: Record<string, string>
  body?: string
  durationMs: number
}

/**
 * Lifecycle hooks for logging, metrics, header injection. See spec §4.10.
 * @public
 */
export interface RequestHooks {
  /** Before request goes on the wire. Return a (possibly modified) RequestEvent to inject headers / correlation IDs. */
  beforeRequest?: (req: RequestEvent) => void | RequestEvent | Promise<undefined | RequestEvent>
  /** After response is received and parsed. */
  afterResponse?: (req: RequestEvent, res: ResponseEvent) => void | Promise<void>
  /** When an error (network/timeout/HTTP) is about to be thrown. */
  onError?: (req: RequestEvent, err: ODataError) => void | Promise<void>
}
