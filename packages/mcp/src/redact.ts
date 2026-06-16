/**
 * Mask `user:password@` userinfo in any URL-like substring. 1С uses Basic auth,
 * so credentials can surface inside error messages / stack traces that quote the
 * request URL. Apply to every string shown to a human or returned to an LLM.
 */
export function redactSecrets(text: string): string {
  // Match up to the LAST `@` before a `/` or whitespace so a password that
  // itself contains `@` is still fully masked.
  return text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s]+@/g, '$1***@')
}

/** Redacted message for any thrown value. */
export function errorText(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err))
}

/**
 * Remove any `user:password@` userinfo from a URL, returning a clean base URL.
 * Defense in depth for a `config.json` that was hand-edited or migrated with
 * credentials in the URL — keeps them out of memory, requests, and tool output.
 */
export function stripUrlUserinfo(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.username === '' && parsed.password === '') return url
    parsed.username = ''
    parsed.password = ''
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}
