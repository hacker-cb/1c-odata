/**
 * Auth strategies supported by core. Currently only `basic`; OAuth/cookie
 * deferred (see spec §8 «вне MVP»).
 * @public
 */
export type AuthOptions = BasicAuthOptions

/**
 * Resolved Basic auth — the value is the Authorization header to inject on
 * every request. Construct via `BasicAuth({ username, password })`.
 * @public
 */
export interface BasicAuthOptions {
  readonly scheme: 'basic'
  readonly header: string
}

/**
 * Build a `BasicAuthOptions` from credentials. The header is materialized once;
 * passwords never appear in logs unless a hook explicitly inspects `.header`.
 * @public
 */
export function BasicAuth(creds: { username: string; password: string }): BasicAuthOptions {
  const encoded = Buffer.from(`${creds.username}:${creds.password}`, 'utf8').toString('base64')
  return { scheme: 'basic', header: `Basic ${encoded}` }
}
