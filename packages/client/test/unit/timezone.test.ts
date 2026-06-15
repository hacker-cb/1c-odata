import { describe, expect, it } from 'vitest'
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
