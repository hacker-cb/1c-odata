import { InvalidArgumentError } from './errors.js'

/**
 * How `parseInZone` places a wall-clock time a daylight-saving switch makes
 * ambiguous or skips:
 *
 * - `'compatible'` (default) — a time the zone passes twice (the clocks go
 *   back) is the EARLIER instant; a time the zone skips (the clocks go forward)
 *   is moved forward by the length of the gap (`02:30` in a 02:00→03:00 gap is
 *   `03:30`). The same rule as `new Date(y, m, d, h)` in JS. Never throws for a
 *   real calendar date: 1С stores a wall-clock time without checking it against
 *   daylight saving, so a value it returns always has an instant.
 * - `'reject'` — a skipped time is an `InvalidArgumentError`; a time passed
 *   twice is still the earlier instant. Unlike `Temporal`'s `'reject'`, which
 *   refuses an ambiguous time as well: this one refuses only a time that has
 *   no instant.
 *
 * `'compatible'` is `Temporal`'s rule of that name.
 *
 * @public
 */
export type ZoneDisambiguation = 'compatible' | 'reject'

/**
 * Options for `parseInZone`.
 *
 * @public
 */
export interface ParseInZoneOptions {
  /** Default `'compatible'`. See `ZoneDisambiguation`. */
  disambiguation?: ZoneDisambiguation
}

/**
 * A naive ISO-8601 date-time: `YYYY-MM-DDTHH:mm`, optionally `:ss`, optionally
 * a fractional second; a space may stand for the `T`. No offset — the
 * wall-clock is read in the zone given.
 */
const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/

const DAY_MS = 86_400_000

/** 1С dates span `0001-01-01` – `9999-12-31` (`0001-01-01T00:00:00` being its "empty date"). */
const MIN_YEAR = 1
const MAX_YEAR = 9999
const YEAR_RANGE = '0001–9999'

const formatters = new Map<string, Intl.DateTimeFormat>()
/** Formatters kept at most — one per zone spelling seen; a caller cycling through more starts the cache over. */
const MAX_FORMATTERS = 64

/**
 * One formatter per zone. `hourCycle: 'h23'` keeps midnight `00` (not `24`);
 * `era` tells a year before 1 AD from its mirror after it. The year comes back
 * WITHOUT leading zeros (`999`), so it is read as a number, never as a string.
 */
function formatterFor(zone: string): Intl.DateTimeFormat {
  // No zone is not the host's zone: `Intl` would silently take the process's.
  if (typeof zone !== 'string' || zone === '') {
    throw new InvalidArgumentError(`An IANA timezone is required, got ${JSON.stringify(zone) ?? String(zone)}`, {
      argument: 'zone',
      received: zone,
    })
  }
  let fmt = formatters.get(zone)
  if (fmt === undefined) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        era: 'short',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hourCycle: 'h23',
      })
    } catch {
      throw new InvalidArgumentError(`Unknown IANA timezone ${JSON.stringify(zone)}`, {
        argument: 'zone',
        received: zone,
      })
    }
    if (formatters.size >= MAX_FORMATTERS) formatters.clear()
    formatters.set(zone, fmt)
  }
  return fmt
}

/** A UTC timestamp for the given fields — `setUTCFullYear`, as `Date.UTC` maps years 0–99 to 1900–1999. */
function utcMs(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  const d = new Date(0)
  d.setUTCFullYear(year, month - 1, day)
  d.setUTCHours(hour, minute, second, 0)
  return d.getTime()
}

/**
 * The zone's offset from UTC at `instant`, in ms (east positive) — the zone's
 * wall-clock at that instant, read as if it were UTC, minus the instant. Whole
 * seconds: a historic local mean time (Moscow before 1880: +02:30:17) keeps them.
 */
function offsetAt(instant: number, zone: string): number {
  const parts: Record<string, string> = {}
  for (const p of formatterFor(zone).formatToParts(new Date(instant))) parts[p.type] = p.value
  const y = Number(parts.year)
  const year = parts.era === 'BC' || parts.era === 'B' ? 1 - y : y
  const wall = utcMs(
    year,
    Number(parts.month),
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  return wall - (instant - (((instant % 1000) + 1000) % 1000))
}

/** At most this many characters of a rejected value go into an error message. */
const SHOWN_CHARS = 64

function invalidNaive(naive: unknown, why: string): InvalidArgumentError {
  const text = typeof naive === 'string' ? naive : String(naive)
  const shown = JSON.stringify(text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS)}…` : text)
  return new InvalidArgumentError(`Invalid naive date-time ${shown}: ${why}`, { argument: 'naive', received: naive })
}

/**
 * Parse a naive ISO-8601 datetime string (`"2025-01-10T15:30:00"`, no offset)
 * as wall-clock in the given IANA timezone. Returns a JS `Date` representing
 * the absolute UTC instant. DST-aware via `Intl`.
 *
 * Accepts `YYYY-MM-DDTHH:mm[:ss[.fff…]]` (or a space for the `T`) for years `0001`–`9999` (1С's range);
 * fractional digits past milliseconds are truncated. A wall-clock time a
 * daylight-saving switch makes ambiguous or skips is placed per
 * `opts.disambiguation` (default `'compatible'` — see `ZoneDisambiguation`).
 *
 * @throws InvalidArgumentError — the string is not that form, names an
 *   impossible calendar value (`2026-02-30`, `24:00`, month `13`) — never rolled
 *   over into the next day or month —, or a year outside 0001–9999; the zone is
 *   not an IANA timezone; or, under `disambiguation: 'reject'`, the time is one
 *   the zone skips.
 * @public
 */
export function parseInZone(naive: string, zone: string, opts?: ParseInZoneOptions): Date {
  const m = typeof naive === 'string' ? NAIVE_RE.exec(naive) : null
  if (m === null) throw invalidNaive(naive, 'expected YYYY-MM-DDTHH:mm[:ss[.fff]] without an offset')
  const [, y, mo, d, hh, mi, ss = '00', frac] = m
  const [year, month, day, hour, minute, second] = [y, mo, d, hh, mi, ss].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  if (year < MIN_YEAR || year > MAX_YEAR) throw invalidNaive(naive, `year outside ${YEAR_RANGE}`)
  const wall = utcMs(year, month, day, hour, minute, second)
  const probe = new Date(wall)
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) {
    throw invalidNaive(naive, 'no such calendar date or time of day')
  }
  // Read the wall-clock as UTC, then place it by the offsets in force a day on
  // either side — before and after any switch near it — and those in force at
  // the instants they give, which catch an offset between two switches close
  // together. An offset that maps the wall-clock back onto itself is a real
  // reading of it: two such are a time passed twice (the earlier wins), none a
  // time the zone skips.
  const before = offsetAt(wall - DAY_MS, zone)
  const after = offsetAt(wall + DAY_MS, zone)
  const offsets = new Set([before, after, offsetAt(wall - before, zone), offsetAt(wall - after, zone)])
  const readings = [...offsets].map((offset) => wall - offset).filter((t) => wall - t === offsetAt(t, zone))
  let instant: number
  if (readings.length > 0) instant = Math.min(...readings)
  else if (opts?.disambiguation === 'reject') {
    throw invalidNaive(naive, `a wall-clock time a daylight-saving switch skips in ${zone}`)
  } else {
    // 'compatible': the offset before the switch moves the time forward by the gap.
    instant = wall - before
  }
  return new Date(instant + parseFractionMs(frac))
}

/**
 * A fractional-seconds suffix as milliseconds (0 if none). Reads the first
 * three digits directly — `5` → 500, `25` → 250, `1234` → 123. Digits beyond
 * millisecond precision are TRUNCATED, not rounded: JS `Date` is
 * millisecond-resolution, and rounding `.9999` up to 1000ms would spill into
 * the next second and shift the instant. Avoiding the float multiply also
 * dodges `0.123 * 1000 = 122.999…` representation errors.
 */
function parseFractionMs(frac: string | undefined): number {
  if (frac === undefined) return 0
  return Number.parseInt(frac.slice(0, 3).padEnd(3, '0'), 10)
}

/**
 * Format a JS `Date` as a naive ISO-8601 wall-clock string in the given
 * IANA timezone. Inverse of `parseInZone`. DST-aware via `Intl`.
 *
 * The year is always four digits (`0999-05-01T…`). Sub-second precision: a
 * `.SSS` suffix is appended only when the instant has a non-zero millisecond
 * component, so second-precision values (all standard 1С datetimes) format
 * exactly as before, while a `Date` carrying milliseconds round-trips without
 * silently losing them.
 *
 * @throws InvalidArgumentError — an invalid `Date`, one whose wall-clock year
 *   in the zone falls outside 1С's 0001–9999, or a zone that is not an IANA
 *   timezone.
 * @public
 */
export function formatInZone(date: Date, zone: string): string {
  // Date.prototype.getTime reads any realm's Date (a `node:vm` one included) and throws for anything else.
  let instant: number
  try {
    instant = Date.prototype.getTime.call(date)
  } catch {
    instant = Number.NaN
  }
  if (Number.isNaN(instant)) {
    throw new InvalidArgumentError('formatInZone needs a valid Date', { argument: 'date', received: date })
  }
  const wall = new Date(instant + offsetAt(instant, zone))
  const year = wall.getUTCFullYear()
  // Negated, so a wall-clock past the range `Date` holds (NaN) fails too.
  if (!(year >= MIN_YEAR && year <= MAX_YEAR)) {
    throw new InvalidArgumentError(
      `Date ${new Date(instant).toISOString()} falls ${Number.isNaN(year) ? 'past the dates JS can hold' : `in year ${year}`} in ${zone}, outside 1С's ${YEAR_RANGE}`,
      { argument: 'date', received: date },
    )
  }
  const p2 = (n: number) => String(n).padStart(2, '0')
  const base =
    `${String(year).padStart(4, '0')}-${p2(wall.getUTCMonth() + 1)}-${p2(wall.getUTCDate())}` +
    `T${p2(wall.getUTCHours())}:${p2(wall.getUTCMinutes())}:${p2(wall.getUTCSeconds())}`
  // Milliseconds are timezone-independent (offsets are whole seconds), so the
  // wall-clock carries the instant's own.
  const ms = wall.getUTCMilliseconds()
  return ms === 0 ? base : `${base}.${String(ms).padStart(3, '0')}`
}
