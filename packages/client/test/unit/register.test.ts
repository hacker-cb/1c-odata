import {
  BasicAuth,
  type DrCrTurnoversArgs,
  InvalidArgumentError,
  ODataV3Client,
  type TurnoversArgs,
} from '@1c-odata/client'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
beforeEach(() => server.resetHandlers())

const baseUrl = 'http://example.test/odata'
const auth = BasicAuth({ username: 'u', password: 'p' })

describe('client.register(...).recordsets / records', () => {
  it('recordsets() returns a query against the parent register EntitySet', async () => {
    server.use(
      http.get(`${baseUrl}/AccumulationRegister_X`, () =>
        HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#AR_X`,
          value: [{ Recorder: 'g1', Recorder_Type: 'StandardODATA.Document_X' }],
        }),
      ),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const r = await c.register('AccumulationRegister_X').recordsets().get()
    expect(r.value).toHaveLength(1)
    expect((r.value[0] as { Recorder: string }).Recorder).toBe('g1')
  })

  it('records() returns a query against <set>_RecordType', async () => {
    server.use(
      http.get(`${baseUrl}/AccumulationRegister_X_RecordType`, () =>
        HttpResponse.json({
          'odata.metadata': `${baseUrl}/$metadata#AR_X_RecordType`,
          value: [{ Period: '2025-01-01T00:00:00', Сумма: 10000 }],
        }),
      ),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const r = await c.register('AccumulationRegister_X').records().get()
    expect(r.value).toHaveLength(1)
  })
})

describe('RegisterHelper.balance / turnovers / balanceAndTurnovers', () => {
  it('balance() calls AccumulationRegister_X/Balance()', async () => {
    let url: string | null = null
    server.use(
      http.get(/\/AccumulationRegister_X\/Balance\(\).*/, ({ request }) => {
        url = request.url
        return HttpResponse.json({ 'odata.metadata': '#X', value: [{ Количество: 5 }] })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const r = await c.register('AccumulationRegister_X').balance({ Period: new Date(2025, 0, 1) })
    expect(url).toContain('AccumulationRegister_X/Balance()')
    expect(r).toEqual([{ Количество: 5 }])
  })

  it('turnovers({Period: {from, to}}) maps the range to StartPeriod/EndPeriod', async () => {
    let url: string | null = null
    server.use(
      http.get(/\/AccumulationRegister_X\/Turnovers\(\).*/, ({ request }) => {
        url = request.url
        return HttpResponse.json({ 'odata.metadata': '#X', value: [] })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.register('AccumulationRegister_X').turnovers({
      Period: { from: new Date(2025, 0, 1), to: new Date(2025, 11, 31) },
    })
    // 1С AccumulationRegister Turnovers takes StartPeriod/EndPeriod — StartDate/EndDate
    // (AccountingRegister tables) are rejected 501 live across УТ 11.1/11.5 + БП 3.0.
    expect(url).toContain('StartPeriod=datetime')
    expect(url).toContain('EndPeriod=datetime')
    expect(url).not.toContain('StartDate')
    expect(url).not.toContain('EndDate')
  })

  it('turnovers({Period: {from}}) emits an open-ended StartPeriod only', async () => {
    let url: string | null = null
    server.use(
      http.get(/\/AccumulationRegister_X\/Turnovers\(\).*/, ({ request }) => {
        url = request.url
        return HttpResponse.json({ 'odata.metadata': '#X', value: [] })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.register('AccumulationRegister_X').turnovers({ Period: { from: new Date(2025, 0, 1) } })
    expect(url).toContain('StartPeriod=datetime')
    expect(url).not.toContain('EndPeriod')
  })

  it('balanceAndTurnovers maps the range to StartPeriod/EndPeriod', async () => {
    let url: string | null = null
    server.use(
      http.get(/\/AccumulationRegister_X\/BalanceAndTurnovers\(\).*/, ({ request }) => {
        url = request.url
        return HttpResponse.json({ 'odata.metadata': '#X', value: [] })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.register('AccumulationRegister_X').balanceAndTurnovers({
      Period: { from: new Date(2025, 0, 1), to: new Date(2025, 11, 31) },
    })
    expect(url).toContain('AccumulationRegister_X/BalanceAndTurnovers()')
    expect(url).toContain('StartPeriod=datetime')
    expect(url).toContain('EndPeriod=datetime')
  })

  it('turnovers() rejects a bare Date period at runtime (no silent all-periods query)', async () => {
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    // A point Date is not a valid turnovers period (no single-point form in 1С).
    // The type forbids it; this simulates an untyped (JS) caller bypassing it —
    // it must fail loudly, not silently emit no period (→ all-periods query).
    const args = { Period: new Date(2025, 0, 1) } as unknown as TurnoversArgs
    await expect(c.register('AccumulationRegister_X').turnovers(args)).rejects.toThrow(InvalidArgumentError)
  })
})

describe('RegisterHelper.sliceFirst / sliceLast (IR)', () => {
  it('sliceLast calls InformationRegister_X/SliceLast()', async () => {
    let url: string | null = null
    server.use(
      http.get(/\/InformationRegister_X\/SliceLast\(\).*/, ({ request }) => {
        url = request.url
        return HttpResponse.json({ 'odata.metadata': '#X', value: [] })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.register('InformationRegister_X').sliceLast({ Period: new Date(2025, 0, 1) })
    expect(url).toContain('InformationRegister_X/SliceLast()')
  })

  it('sliceFirst calls InformationRegister_X/SliceFirst()', async () => {
    let url: string | null = null
    server.use(
      http.get(/\/InformationRegister_X\/SliceFirst\(\).*/, ({ request }) => {
        url = request.url
        return HttpResponse.json({ 'odata.metadata': '#X', value: [] })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.register('InformationRegister_X').sliceFirst({ Period: new Date(2025, 0, 1) })
    expect(url).toContain('SliceFirst')
  })
})

describe('RegisterHelper bookkeeping methods (AR)', () => {
  it('drCrTurnovers maps the range to StartPeriod/EndPeriod and forwards AccountCondition', async () => {
    let url: string | null = null
    server.use(
      http.get(/\/AccountingRegister_X\/DrCrTurnovers\(\).*/, ({ request }) => {
        url = request.url
        return HttpResponse.json({ 'odata.metadata': '#X', value: [] })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.register('AccountingRegister_X').drCrTurnovers({
      Period: { from: new Date(2025, 0, 1), to: new Date(2025, 11, 31) },
      AccountCondition: "Account_Key eq guid'g1'",
    })
    // 1С AccountingRegister DrCrTurnovers takes StartPeriod/EndPeriod (StartDate/EndDate 501 live)
    // and string AccountCondition (NOT @odata.bind AccountDr/AccountCr, which don't exist in the schema).
    expect(url).toContain('StartPeriod=datetime')
    expect(url).toContain('EndPeriod=datetime')
    expect(url).not.toContain('StartDate')
    expect(url).not.toContain('EndDate')
    expect(url !== null && decodeURIComponent(url)).toContain("AccountCondition='Account_Key eq guid")
  })

  it('drCrTurnovers rejects a bare Date period at runtime', async () => {
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const args = { Period: new Date(2025, 0, 1) } as unknown as DrCrTurnoversArgs
    await expect(c.register('AccountingRegister_X').drCrTurnovers(args)).rejects.toThrow(InvalidArgumentError)
  })

  it('extDimensions calls ExtDimensions() with no parameters', async () => {
    let url: string | null = null
    server.use(
      http.get(/\/AccountingRegister_X\/ExtDimensions\(\).*/, ({ request }) => {
        url = request.url
        return HttpResponse.json({ 'odata.metadata': '#X', value: [] })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.register('AccountingRegister_X').extDimensions()
    expect(url).toContain('AccountingRegister_X/ExtDimensions()')
    expect(url).not.toContain('Account_Key')
  })

  it('recordsWithExtDimensions maps the range to StartPeriod/EndPeriod and forwards Top', async () => {
    let url: string | null = null
    server.use(
      http.get(/\/AccountingRegister_X\/RecordsWithExtDimensions\(\).*/, ({ request }) => {
        url = request.url
        return HttpResponse.json({ 'odata.metadata': '#X', value: [] })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.register('AccountingRegister_X').recordsWithExtDimensions({
      Period: { from: new Date(2025, 0, 1), to: new Date(2025, 11, 31) },
      Top: 10,
    })
    expect(url).toContain('StartPeriod=datetime')
    expect(url).toContain('EndPeriod=datetime')
    expect(url).not.toContain('StartDate')
    expect(url).toContain('Top=10')
  })
})

describe('RegisterHelper ReadFiOptions ($top)', () => {
  it('appends $top to a FI with args (after &)', async () => {
    let url: string | null = null
    server.use(
      http.get(/\/AccumulationRegister_X\/Balance\(\).*/, ({ request }) => {
        url = request.url
        return HttpResponse.json({ 'odata.metadata': '#X', value: [] })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.register('AccumulationRegister_X').balance({ Period: new Date(2025, 0, 1) }, { top: 5 })
    expect(url !== null && decodeURIComponent(url)).toContain('$top=5')
    expect(url).toContain('Period=datetime')
  })

  it('appends $top to a no-arg FI (after ?)', async () => {
    let url: string | null = null
    server.use(
      http.get(/\/AccountingRegister_X\/ExtDimensions\(\).*/, ({ request }) => {
        url = request.url
        return HttpResponse.json({ 'odata.metadata': '#X', value: [] })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.register('AccountingRegister_X').extDimensions({ top: 3 })
    expect(url !== null && decodeURIComponent(url)).toContain('ExtDimensions()?$top=3')
  })

  it('rejects a non-integer $top before issuing the request', async () => {
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await expect(c.register('AccumulationRegister_X').balance({}, { top: 1.5 })).rejects.toThrow(InvalidArgumentError)
    await expect(c.register('AccumulationRegister_X').balance({}, { top: -1 })).rejects.toThrow(InvalidArgumentError)
  })
})

describe('RegisterHelper forwards AccountingRegister filters on shared FIs', () => {
  it('turnovers() forwards AccountCondition (not silently dropped on an AccountingRegister)', async () => {
    let url: string | null = null
    server.use(
      http.get(/\/AccountingRegister_X\/Turnovers\(\).*/, ({ request }) => {
        url = request.url
        return HttpResponse.json({ 'odata.metadata': '#X', value: [] })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.register('AccountingRegister_X').turnovers({
      Period: { from: new Date(2025, 0, 1), to: new Date(2025, 11, 31) },
      AccountCondition: "Account_Key eq guid'g1'",
      ExtraDimensions: "Субконто1 eq guid'g2'",
    })
    expect(url !== null && decodeURIComponent(url)).toContain("AccountCondition='Account_Key eq guid")
    expect(url !== null && decodeURIComponent(url)).toContain("ExtraDimensions='Субконто1 eq guid")
  })
})
