function getZoneOffsetMs(date: Date, zone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value])) as Record<string, string>
  const hour = parts.hour === '24' ? '00' : parts.hour
  const wallClockUtc = `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}Z`
  return Date.parse(wallClockUtc) - date.getTime()
}

/**
 * Parse a naive ISO-8601 datetime string (`"2025-01-10T15:30:00"`, no offset)
 * as wall-clock in the given IANA timezone. Returns a JS `Date` representing
 * the absolute UTC instant. DST-aware via `Intl`.
 *
 * @public
 */
export function parseInZone(naive: string, zone: string): Date {
  const guess = new Date(`${naive}Z`)
  const offsetMs = getZoneOffsetMs(guess, zone)
  const candidate = new Date(guess.getTime() - offsetMs)
  // Verify round-trip: if candidate maps back to a different wall-clock
  // (e.g. DST fall-back ambiguity), refine with the corrected offset.
  const check = formatInZone(candidate, zone)
  if (check === naive) return candidate
  const offsetMs2 = getZoneOffsetMs(candidate, zone)
  return new Date(guess.getTime() - offsetMs2)
}

/**
 * Format a JS `Date` as a naive ISO-8601 wall-clock string in the given
 * IANA timezone. Inverse of `parseInZone`. DST-aware via `Intl`.
 *
 * @public
 */
export function formatInZone(date: Date, zone: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value])) as Record<string, string>
  const hour = parts.hour === '24' ? '00' : parts.hour
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}`
}
