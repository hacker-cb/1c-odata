import type { ODataV3ClientOptions } from './client/v3-client.js'
import { type Connection, connectionAuth } from './connection.js'

/**
 * Convert a project-level `Connection` into runtime `ODataV3ClientOptions`.
 * Pure pass-through — does not read env, does not parse URLs.
 *
 * `serverTimezone` is guaranteed by the `Connection` type contract (required).
 *
 * @public
 */
export function clientOptionsFromConnection(conn: Connection): ODataV3ClientOptions {
  return {
    baseUrl: conn.baseUrl,
    serverTimezone: conn.serverTimezone,
    auth: connectionAuth(conn),
    ...(conn.shape !== undefined ? { shape: conn.shape } : {}),
  }
}
