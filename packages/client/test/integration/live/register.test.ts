import { beforeAll, describe, expect, it } from 'vitest'
import { activeFixtures, makeClient } from '../helpers.js'

// Read-only live coverage for register virtual-table function imports across
// Accumulation / Information / Accounting registers. A wrong parameter name or
// URL form makes 1С reject the request (HTTP 501 «Параметр … не поддерживается»
// for bad params, HTTP 400 «лишние сегменты» for a wrong binding), which the
// client surfaces as a thrown ODataError — so each call *resolving to an array*
// IS the assertion here.
//
// MSW unit tests cannot catch this class of bug: they only echo whatever URL the
// client builds, so they pass even when the live server would reject it. This is
// exactly how the StartDate/EndDate→501 and @odata.bind bugs shipped green.
//
// `{ top }` bounds the result — big registers (e.g. AccountingRegister) return
// enormous collections; this keeps the call fast and the test honest.
//
// The period is one closed past month, not a span of years: `top` caps the rows
// returned, not the work — 1С builds the whole virtual table over the period
// first. Over 2020–2035 `turnovers` / `drCrTurnovers` took 3–8 s and at times
// passed 30 s on CI (#238); over a month they take well under a second. The
// URL shape under test (StartPeriod / EndPeriod, a point Period) is the same.
const from = new Date('2025-06-01T00:00:00Z')
const to = new Date('2025-06-30T23:59:59Z')
const TOP = { top: 50 }

for (const { fixture, profile } of activeFixtures()) {
  const reg = profile.register
  if (!reg) continue

  describe(`live register virtual tables: ${fixture.id}`, () => {
    let client: ReturnType<typeof makeClient>
    beforeAll(() => {
      client = makeClient(fixture)
    })

    // ── AccumulationRegister ──────────────────────────────────────────────
    it(`balance({ Period }) on ${reg.balanceSet} resolves to an array (point Period)`, async () => {
      const rows = await client.register(reg.balanceSet).balance({ Period: to }, TOP)
      expect(Array.isArray(rows)).toBe(true)
    }, 30_000)

    it(`turnovers({ Period: { from, to } }) on ${reg.balanceSet} resolves (StartPeriod/EndPeriod)`, async () => {
      const rows = await client.register(reg.balanceSet).turnovers({ Period: { from, to } }, TOP)
      expect(Array.isArray(rows)).toBe(true)
    }, 30_000)

    it(`balanceAndTurnovers({ Period: { from, to } }) on ${reg.balanceSet} resolves`, async () => {
      const rows = await client.register(reg.balanceSet).balanceAndTurnovers({ Period: { from, to } }, TOP)
      expect(Array.isArray(rows)).toBe(true)
    }, 30_000)

    if (reg.turnoverSet) {
      const turnoverSet = reg.turnoverSet
      it(`turnovers({ Period: { from, to } }) on a turnovers-only register (${turnoverSet}) resolves`, async () => {
        const rows = await client.register(turnoverSet).turnovers({ Period: { from, to } }, TOP)
        expect(Array.isArray(rows)).toBe(true)
      }, 30_000)
    }

    // ── InformationRegister ───────────────────────────────────────────────
    if (reg.infoSet) {
      const infoSet = reg.infoSet
      it(`sliceLast({ Period }) on ${infoSet} resolves to an array`, async () => {
        const rows = await client.register(infoSet).sliceLast({ Period: to }, TOP)
        expect(Array.isArray(rows)).toBe(true)
      }, 30_000)

      it(`sliceFirst({ Period }) on ${infoSet} resolves to an array`, async () => {
        const rows = await client.register(infoSet).sliceFirst({ Period: to }, TOP)
        expect(Array.isArray(rows)).toBe(true)
      }, 30_000)
    }

    // ── AccountingRegister ────────────────────────────────────────────────
    if (reg.accountingSet) {
      const acc = reg.accountingSet
      it(`drCrTurnovers({ Period: { from, to } }) on ${acc} resolves (StartPeriod/EndPeriod)`, async () => {
        const rows = await client.register(acc).drCrTurnovers({ Period: { from, to } }, TOP)
        expect(Array.isArray(rows)).toBe(true)
      }, 30_000)

      it(`count() of ${acc}/Turnovers with a select counts the rows get() returns (#215)`, async () => {
        // On БП 3.0 a $select rolls the virtual table up by account, and /$count with it counts
        // those rows; without it, every account × ext-dimension × balanced-account row instead.
        // A closed past year, so a posting between the two reads cannot change the rows.
        const set = `${acc}/Turnovers(StartPeriod=datetime'2025-01-01T00:00:00',EndPeriod=datetime'2025-12-31T23:59:59')`
        const q = () => client.query(set).select('Account_Key', 'СуммаTurnoverDr')
        const [page, total] = await Promise.all([q().get(), q().count()])
        expect(total).toBe(page.value.length)
      }, 60_000)

      it(`recordsWithExtDimensions({ Period: { from, to }, Top }) on ${acc} resolves`, async () => {
        const rows = await client.register(acc).recordsWithExtDimensions({ Period: { from, to }, Top: 1 }, TOP)
        expect(Array.isArray(rows)).toBe(true)
      }, 30_000)

      it(`extDimensions() on ${acc} resolves (no parameters)`, async () => {
        const rows = await client.register(acc).extDimensions(TOP)
        expect(Array.isArray(rows)).toBe(true)
      }, 30_000)

      it(`balance/turnovers on the accounting register ${acc} resolve`, async () => {
        expect(Array.isArray(await client.register(acc).balance({ Period: to }, TOP))).toBe(true)
        expect(Array.isArray(await client.register(acc).turnovers({ Period: { from, to } }, TOP))).toBe(true)
      }, 30_000)
    }
  })
}
