import { BasicAuth, ODataV3Client } from '@1c-odata/client'
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

  it('turnovers({Period: {from, to}}) flattens range to two args', async () => {
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
    expect(url).toContain('StartDate=datetime')
    expect(url).toContain('EndDate=datetime')
  })

  it('balanceAndTurnovers calls AccumulationRegister_X/BalanceAndTurnovers()', async () => {
    let url: string | null = null
    server.use(
      http.get(/\/AccumulationRegister_X\/BalanceAndTurnovers\(\).*/, ({ request }) => {
        url = request.url
        return HttpResponse.json({ 'odata.metadata': '#X', value: [] })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.register('AccumulationRegister_X').balanceAndTurnovers({ Period: new Date(2025, 0, 1) })
    expect(url).toContain('AccumulationRegister_X/BalanceAndTurnovers()')
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
  it('drCrTurnovers passes StartDate/EndDate', async () => {
    let url: string | null = null
    server.use(
      http.get(/\/AccountingRegister_X\/DrCrTurnovers\(\).*/, ({ request }) => {
        url = request.url
        return HttpResponse.json({ 'odata.metadata': '#X', value: [] })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.register('AccountingRegister_X').drCrTurnovers({
      StartDate: new Date(2025, 0, 1),
      EndDate: new Date(2025, 11, 31),
    })
    expect(url).toContain('StartDate=datetime')
    expect(url).toContain('EndDate=datetime')
  })

  it('extDimensions passes Account_Key', async () => {
    let url: string | null = null
    server.use(
      http.get(/\/AccountingRegister_X\/ExtDimensions\(\).*/, ({ request }) => {
        url = request.url
        return HttpResponse.json({ 'odata.metadata': '#X', value: [] })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.register('AccountingRegister_X').extDimensions({ Account_Key: 'g' })
    // `request.url` is percent-encoded by MSW (`'` → `%27`); decode before asserting.
    expect(url !== null && decodeURIComponent(url)).toContain("Account_Key='g'")
  })

  it('recordsWithExtDimensions passes StartDate/EndDate', async () => {
    let url: string | null = null
    server.use(
      http.get(/\/AccountingRegister_X\/RecordsWithExtDimensions\(\).*/, ({ request }) => {
        url = request.url
        return HttpResponse.json({ 'odata.metadata': '#X', value: [] })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.register('AccountingRegister_X').recordsWithExtDimensions({
      StartDate: new Date(2025, 0, 1),
      EndDate: new Date(2025, 11, 31),
    })
    expect(url).toContain('StartDate=datetime')
  })

  it('drCrTurnovers serializes @odata.bind args correctly', async () => {
    let url: string | null = null
    server.use(
      http.get(/\/AccountingRegister_X\/DrCrTurnovers\(\).*/, ({ request }) => {
        url = request.url
        return HttpResponse.json({ 'odata.metadata': '#X', value: [] })
      }),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.register('AccountingRegister_X').drCrTurnovers({
      AccountDr: { '@odata.bind': "ChartOfAccounts_X(guid'g1')" },
      AccountCr: { '@odata.bind': "ChartOfAccounts_X(guid'g2')" },
    })
    expect(url).not.toContain('[object Object]')
    expect(decodeURIComponent(url!)).toContain(`AccountDr='ChartOfAccounts_X(guid''g1'')'`)
    expect(decodeURIComponent(url!)).toContain(`AccountCr='ChartOfAccounts_X(guid''g2'')'`)
  })
})
