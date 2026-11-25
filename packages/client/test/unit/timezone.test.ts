import { describe, expect, it } from 'vitest'
import { InvalidArgumentError } from '../../src/errors.js'
import { formatInZone, parseInZone } from '../../src/timezone.js'

describe('parseInZone', () => {
  it('parses naive Moscow datetime to absolute Date', () => {
    const d = parseInZone('2025-01-10T15:30:00', 'Europe/Moscow')
    // Moscow is UTC+3 → 15:30 Moscow = 12:30 UTC
    expect(d.toISOString()).toBe('2025-01-10T12:30:00.000Z')
  })

  it('parses naive Berlin datetime in winter (CET = UTC+1)', () => {
    const d = parseInZone('2025-01-10T15:30:00', 'Europe/Berlin')
    expect(d.toISOString()).toBe('2025-01-10T14:30:00.000Z')
  })

  it('parses naive Berlin datetime in summer (CEST = UTC+2)', () => {
    const d = parseInZone('2025-07-15T15:30:00', 'Europe/Berlin')
    expect(d.toISOString()).toBe('2025-07-15T13:30:00.000Z')
  })

  it('parses naive UTC datetime as UTC', () => {
    const d = parseInZone('2025-01-10T15:30:00', 'UTC')
    expect(d.toISOString()).toBe('2025-01-10T15:30:00.000Z')
  })

  it('truncates sub-millisecond fractional digits instead of rounding into the next second', () => {
    // `.9999` s = 999.9 ms → must truncate to 999 ms, NOT round to 1000 ms
    // (which would spill into :01). JS Date is millisecond-resolution.
    const d = parseInZone('2025-06-15T10:00:00.9999', 'UTC')
    expect(d.toISOString()).toBe('2025-06-15T10:00:00.999Z')
  })

  it('parses fractional seconds exactly (no binary-float drift)', () => {
    // `0.123 * 1000` is 122.999… in float — the digit-based parse avoids it.
    expect(parseInZone('2025-06-15T10:00:00.123', 'UTC').toISOString()).toBe('2025-06-15T10:00:00.123Z')
    expect(parseInZone('2025-06-15T10:00:00.1', 'UTC').toISOString()).toBe('2025-06-15T10:00:00.100Z')
  })
})

describe('formatInZone', () => {
  it('formats absolute Date back to Moscow wall-clock', () => {
    const d = new Date('2025-01-10T12:30:00.000Z')
    expect(formatInZone(d, 'Europe/Moscow')).toBe('2025-01-10T15:30:00')
  })

  it('round-trips parse → format with Moscow', () => {
    const naive = '2025-06-15T10:00:00'
    const d = parseInZone(naive, 'Europe/Moscow')
    expect(formatInZone(d, 'Europe/Moscow')).toBe(naive)
  })

  it('round-trips parse → format across DST transition (Berlin)', () => {
    const naive = '2025-10-26T01:30:00'
    const d = parseInZone(naive, 'Europe/Berlin')
    expect(formatInZone(d, 'Europe/Berlin')).toBe(naive)
  })

  it('omits the fractional suffix for second-precision instants (unchanged wire form)', () => {
    const d = new Date('2025-01-10T12:30:00.000Z')
    expect(formatInZone(d, 'Europe/Moscow')).toBe('2025-01-10T15:30:00')
  })

  it('preserves milliseconds instead of silently truncating them on write', () => {
    const d = new Date('2025-01-10T12:30:00.250Z')
    expect(formatInZone(d, 'Europe/Moscow')).toBe('2025-01-10T15:30:00.250')
  })

  it('round-trips a fractional-seconds wall-clock without loss', () => {
    const naive = '2025-06-15T10:00:00.250'
    const d = parseInZone(naive, 'Europe/Moscow')
    expect(d.toISOString()).toBe('2025-06-15T07:00:00.250Z')
    expect(formatInZone(d, 'Europe/Moscow')).toBe(naive)
  })

  it('still resolves the correct instant for a fractional input across DST (Berlin)', () => {
    const d = parseInZone('2025-10-26T01:30:00.500', 'Europe/Berlin')
    expect(formatInZone(d, 'Europe/Berlin')).toBe('2025-10-26T01:30:00.500')
  })
})

describe('parseInZone — years, calendar and daylight saving (#193)', () => {
  it.each([
    ['0999-05-01T00:00:00', 'UTC', '0999-05-01T00:00:00.000Z'],
    ['0001-01-01T00:00:00', 'UTC', '0001-01-01T00:00:00.000Z'],
    ['0050-03-01T10:00:00', 'UTC', '0050-03-01T10:00:00.000Z'], // not shifted to 1950
    ['0999-05-01T00:00:00', 'Europe/Moscow', '0999-04-30T21:29:43.000Z'], // local mean time +02:30:17
    ['9999-12-31T23:59:59', 'Europe/Moscow', '9999-12-31T20:59:59.000Z'],
  ])('reads %s in %s across 1С’s whole year range', (naive, zone, expected) => {
    const d = parseInZone(naive, zone)
    expect(d.toISOString()).toBe(expected)
    expect(formatInZone(d, zone)).toBe(naive)
  })

  it.each([
    ['2026-02-30T00:00:00', 'no such calendar date'],
    ['2026-13-01T00:00:00', 'no such calendar date'],
    ['2026-01-01T24:00:00', 'no such calendar date'],
    ['2026-01-01T10:60:00', 'no such calendar date'],
    ['0000-01-01T00:00:00', 'year outside 0001–9999'],
    ['2026-01-01', 'expected YYYY-MM-DDTHH:mm'],
    ['2026-01-01T10:00:00Z', 'expected YYYY-MM-DDTHH:mm'],
    ['yesterday', 'expected YYYY-MM-DDTHH:mm'],
  ])('rejects %s instead of rolling it over', (naive, why) => {
    expect(() => parseInZone(naive, 'Europe/Moscow')).toThrow(InvalidArgumentError)
    expect(() => parseInZone(naive, 'Europe/Moscow')).toThrow(why)
  })

  it('accepts minutes-only and a space for the T', () => {
    expect(parseInZone('2025-01-10T15:30', 'Europe/Moscow').toISOString()).toBe('2025-01-10T12:30:00.000Z')
    expect(parseInZone('2025-01-10 15:30:00', 'Europe/Moscow').toISOString()).toBe('2025-01-10T12:30:00.000Z')
  })

  it('rejects a zone that is not an IANA timezone', () => {
    expect(() => parseInZone('2025-01-10T15:30:00', 'Mars/Base')).toThrow(InvalidArgumentError)
  })

  it.each([
    // The clocks go forward: the skipped time moves forward by the gap.
    ['America/Sao_Paulo', '2018-11-04T00:00:00', '2018-11-04T03:00:00.000Z', '2018-11-04T01:00:00'],
    ['America/Sao_Paulo', '2018-11-04T00:30:00', '2018-11-04T03:30:00.000Z', '2018-11-04T01:30:00'],
    ['Europe/Berlin', '2025-03-30T02:30:00', '2025-03-30T01:30:00.000Z', '2025-03-30T03:30:00'],
    ['Pacific/Apia', '2011-12-30T12:00:00', '2011-12-30T22:00:00.000Z', '2011-12-31T12:00:00'], // a whole day skipped
  ])('%s: %s, a time the zone skips, moves forward by the gap (compatible)', (zone, naive, instant, wall) => {
    const d = parseInZone(naive, zone)
    expect(d.toISOString()).toBe(instant)
    expect(formatInZone(d, zone)).toBe(wall)
  })

  it.each([
    // The clocks go back: the time passed twice is the earlier instant, in every zone.
    ['Europe/Berlin', '2025-10-26T02:30:00', '2025-10-26T00:30:00.000Z'],
    ['America/Sao_Paulo', '2019-02-16T23:30:00', '2019-02-17T01:30:00.000Z'],
    ['America/New_York', '2025-11-02T01:30:00', '2025-11-02T05:30:00.000Z'],
  ])('%s: %s, a time the zone passes twice, is the earlier instant', (zone, naive, instant) => {
    const d = parseInZone(naive, zone)
    expect(d.toISOString()).toBe(instant)
    expect(formatInZone(d, zone)).toBe(naive)
    expect(parseInZone(naive, zone, { disambiguation: 'reject' }).toISOString()).toBe(instant)
  })

  it("refuses a skipped time under disambiguation: 'reject'", () => {
    expect(() => parseInZone('2018-11-04T00:30:00', 'America/Sao_Paulo', { disambiguation: 'reject' })).toThrow(
      'a wall-clock time a daylight-saving switch skips in America/Sao_Paulo',
    )
    expect(parseInZone('2018-11-04T01:00:00', 'America/Sao_Paulo', { disambiguation: 'reject' }).toISOString()).toBe(
      '2018-11-04T03:00:00.000Z',
    )
  })

  it('keeps milliseconds across a skipped time', () => {
    expect(parseInZone('2025-03-30T02:30:00.250', 'Europe/Berlin').toISOString()).toBe('2025-03-30T01:30:00.250Z')
  })
})

describe('formatInZone — 1С’s year range (#193)', () => {
  it('writes a year below 1000 with its leading zeros', () => {
    expect(formatInZone(new Date('0999-05-01T00:00:00Z'), 'UTC')).toBe('0999-05-01T00:00:00')
    expect(formatInZone(new Date('0001-01-01T00:00:00Z'), 'UTC')).toBe('0001-01-01T00:00:00')
  })

  it('rejects an invalid Date and a year outside 0001–9999 in the zone', () => {
    expect(() => formatInZone(new Date(Number.NaN), 'UTC')).toThrow(InvalidArgumentError)
    expect(() => formatInZone(new Date('9999-12-31T22:00:00Z'), 'Europe/Moscow')).toThrow('year 10000')
    expect(() => formatInZone(new Date('0000-12-31T00:00:00Z'), 'UTC')).toThrow('year 0')
  })
})
