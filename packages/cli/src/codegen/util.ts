/**
 * Locale-aware string compare for Cyrillic identifiers. Used by emitters to
 * produce deterministic, human-friendly file order.
 */
export function compareCyrillic(a: string, b: string): number {
  return a.localeCompare(b, 'ru')
}
