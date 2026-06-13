/**
 * Mask `user:password@` userinfo in any URL-like substring. 1С uses Basic auth,
 * so credentials can surface inside error messages / stack traces that quote the
 * request URL. Apply to every string shown to a human or returned to an LLM.
 */
export function redactSecrets(text: string): string {
  return text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]+@/g, '$1***@')
}

/** Redacted message for any thrown value. */
export function errorText(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err))
}
