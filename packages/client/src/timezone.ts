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
  // Resolve the zone offset on the SECOND-precision wall-clock only, then
  // re-apply any sub-second suffix at the end. Folding milliseconds into the
  // offset math corrupts them: the IANA offset is whole-minute, but
  // `getZoneOffsetMs` derives it against an Intl wall-clock truncated to
  // seconds, so a millisecond-bearing input would shift by its own fraction.
  const fractionMs = parseFractionMs(naive)
  const seconds = secondsOnly(naive)
  const guess = new Date(`${seconds}Z`)
  const offsetMs = getZoneOffsetMs(guess, zone)
  let candidate = new Date(guess.getTime() - offsetMs)
  // Verify round-trip: if candidate maps back to a different wall-clock (e.g.
  // DST fall-back ambiguity), refine with the corrected offset.
  if (formatInZone(candidate, zone) !== seconds) {
    const offsetMs2 = getZoneOffsetMs(candidate, zone)
    candidate = new Date(guess.getTime() - offsetMs2)
  }
  return fractionMs === 0 ? candidate : new Date(candidate.getTime() + fractionMs)
}

/** Drop any fractional-seconds suffix (`.123`) from a naive datetime string. */
function secondsOnly(naive: string): string {
  return naive.replace(/\.\d+$/, '')
}

/** Parse a naive datetime's fractional-seconds suffix into milliseconds (0 if none). */
function parseFractionMs(naive: string): number {
  const m = /\.(\d+)$/.exec(naive)
  return m === null ? 0 : Math.round(Number(`0.${m[1]}`) * 1000)
}

/**
 * Format a JS `Date` as a naive ISO-8601 wall-clock string in the given
 * IANA timezone. Inverse of `parseInZone`. DST-aware via `Intl`.
 *
 * Sub-second precision: a `.SSS` suffix is appended only when the instant has
 * a non-zero millisecond component, so second-precision values (all standard
 * 1С datetimes) format exactly as before, while a `Date` carrying milliseconds
 * round-trips without silently losing them.
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
  const base = `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}`
  // Milliseconds are timezone-independent (offsets are whole minutes), so read
  // them straight off the UTC instant.
  const ms = date.getUTCMilliseconds()
  return ms === 0 ? base : `${base}.${String(ms).padStart(3, '0')}`
}
