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

describe('RegisterHelper ReadFiOptions ($select / $filter)', () => {
  /** Capture the URL of one virtual-table call. */
  function capture(pattern: RegExp): { url: () => string } {
    let url = ''
    server.use(
      http.get(pattern, ({ request }) => {
        url = request.url
        return HttpResponse.json({ 'odata.metadata': '#X', value: [] })
      }),
    )
    return { url: () => url }
  }
  const client = () => new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })

  it('appends $select (the grouping) and $filter, encoded like a collection query', async () => {
    const seen = capture(/\/AccountingRegister_X\/Turnovers\(\).*/)
    await client()
      .register('AccountingRegister_X')
      .turnovers(
        { Period: { from: new Date(2026, 0, 1) }, AccountCondition: "Account_Key eq guid'g1'" },
        { select: ['Account_Key', 'СуммаTurnoverDr'], filter: 'СуммаTurnoverDr gt 100000', top: 10 },
      )
    const url = seen.url()
    expect(url).toContain(`%24select=${encodeURIComponent('Account_Key,СуммаTurnoverDr')}`)
    expect(url).toContain(`%24filter=${encodeURIComponent('СуммаTurnoverDr gt 100000')}`)
    expect(url).toContain('$top=10')
    // The FI's own parameters stay in the query string ahead of the system options.
    expect(decodeURIComponent(url)).toMatch(
      /Turnovers\(\)\?StartPeriod=.*AccountCondition=.*\$filter=.*\$select=.*\$top=10$/,
    )
  })

  it('applies to a no-arg virtual table (after ?)', async () => {
    const seen = capture(/\/AccountingRegister_X\/ExtDimensions\(\).*/)
    await client()
      .register('AccountingRegister_X')
      .extDimensions({ select: ['Type_Key'] })
    expect(decodeURIComponent(seen.url())).toContain('ExtDimensions()?$select=Type_Key')
  })

  it.each([
    ['balance', (r: ReturnType<ReturnType<typeof client>['register']>) => r.balance({}, { select: ['A'] })],
    ['turnovers', (r: ReturnType<ReturnType<typeof client>['register']>) => r.turnovers({}, { select: ['A'] })],
    [
      'balanceAndTurnovers',
      (r: ReturnType<ReturnType<typeof client>['register']>) => r.balanceAndTurnovers({}, { select: ['A'] }),
    ],
    ['sliceFirst', (r: ReturnType<ReturnType<typeof client>['register']>) => r.sliceFirst({}, { select: ['A'] })],
    ['sliceLast', (r: ReturnType<ReturnType<typeof client>['register']>) => r.sliceLast({}, { select: ['A'] })],
    ['drCrTurnovers', (r: ReturnType<ReturnType<typeof client>['register']>) => r.drCrTurnovers({}, { select: ['A'] })],
    [
      'recordsWithExtDimensions',
      (r: ReturnType<ReturnType<typeof client>['register']>) => r.recordsWithExtDimensions({}, { select: ['A'] }),
    ],
  ])('%s forwards $select', async (_name, call) => {
    const seen = capture(/\/Register_X\/\w+\(\).*/)
    await call(client().register('Register_X'))
    expect(decodeURIComponent(seen.url())).toContain('$select=A')
  })

  it('sends neither option for an empty list, blank entries or a blank filter', async () => {
    const seen = capture(/\/AccumulationRegister_X\/Balance\(\).*/)
    await client()
      .register('AccumulationRegister_X')
      .balance({}, { select: [' ', ''], filter: '   ' })
    expect(decodeURIComponent(seen.url())).not.toMatch(/\$select|\$filter/)
    await client()
      .register('AccumulationRegister_X')
      .balance({}, { select: [' Номенклатура_Key ', ''] })
    expect(decodeURIComponent(seen.url())).toContain('$select=Номенклатура_Key')
  })

  it.each([
    ['a string select', { select: 'A,B' }],
    ['a non-string select entry', { select: ['A', null] }],
    ['a sparse select array', { select: new Array<string>(2) }],
    ['a non-string filter', { filter: 42 }],
    ['a null filter', { filter: null }],
  ])('rejects %s from an untyped caller before issuing the request', async (_name, bad) => {
    const opts = bad as unknown as { select?: string[]; filter?: string }
    await expect(client().register('AccumulationRegister_X').balance({}, opts)).rejects.toThrow(InvalidArgumentError)
  })
})

describe('RegisterHelper ReadFiOptions ($skip / $orderby / count) — server-side paging (#192)', () => {
  /**
   * Answer a virtual table's page with `body` and its `/$count` with `count`
   * (an HTTP error where `count` is a number ≥ 400 passed as `{ status }`),
   * recording every URL asked for.
   */
  function capture(
    table: string,
    body: Record<string, unknown> = { 'odata.metadata': '#X', value: [] },
    count: string | { status: number } = '0',
  ) {
    const urls: string[] = []
    server.use(
      http.get(new RegExp(`/${table}/\\$count`), ({ request }) => {
        urls.push(request.url)
        return typeof count === 'string'
          ? new HttpResponse(`\uFEFF${count}`, { headers: { 'Content-Type': 'text/plain' } })
          : HttpResponse.json({ 'odata.error': { code: '', message: { value: 'boom' } } }, count)
      }),
      http.get(new RegExp(`/${table}(\\?.*)?$`), ({ request }) => {
        urls.push(request.url)
        return HttpResponse.json(body)
      }),
    )
    const pageUrl = () => decodeURIComponent(urls.find((u) => !u.includes('/$count')) ?? '')
    const countUrl = () => decodeURIComponent(urls.find((u) => u.includes('/$count')) ?? '')
    return { urls, pageUrl, countUrl }
  }
  const client = () => new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })

  it('sends $orderby, $top and $skip after the FI parameters, never $inlinecount', async () => {
    const seen = capture('AccountingRegister_X/Turnovers\\(\\)', {
      'odata.metadata': '#X',
      value: [{ СуммаTurnoverDr: 5, Period: '2026-01-01T00:00:00' }],
    })
    const rows = await client()
      .register('AccountingRegister_X')
      .turnovers(
        { Period: { from: new Date(2026, 0, 1) } },
        { orderBy: [{ field: ' СуммаTurnoverDr ', dir: 'desc' }, { field: 'Account_Key' }], top: 50, skip: 100 },
      )
    expect(seen.urls).toHaveLength(1)
    expect(seen.urls[0]).toContain(`%24orderby=${encodeURIComponent('СуммаTurnoverDr desc,Account_Key asc')}`)
    expect(seen.pageUrl()).toMatch(/Turnovers\(\)\?StartPeriod=.*\$orderby=.*&\$top=50&\$skip=100$/)
    expect(seen.pageUrl()).not.toContain('inlinecount')
    // Without count the rows come back bare, parsed as before: a naive date-time becomes a Date.
    expect(rows).toHaveLength(1)
    expect(rows[0]?.Period).toBeInstanceOf(Date)
  })

  it("with count: true also asks the table's /$count — same parameters, $filter and $select — and resolves to both", async () => {
    const seen = capture(
      'AccountingRegister_X/Turnovers\\(\\)',
      { 'odata.metadata': '#X', value: [{ A: 1 }] },
      '234859',
    )
    const page = await client()
      .register('AccountingRegister_X')
      .turnovers(
        { Period: { from: new Date(2026, 0, 1) }, AccountCondition: "Account_Key eq guid'g1'" },
        { filter: 'A gt 0', select: ['A'], orderBy: [{ field: 'A' }], top: 1, skip: 7, count: true },
      )
    expect(page).toEqual({ value: [{ A: 1 }], count: 234859 })
    expect(seen.urls).toHaveLength(2)
    expect(seen.pageUrl()).toMatch(
      /Turnovers\(\)\?StartPeriod=.*AccountCondition=.*\$filter=A gt 0&\$select=A&\$orderby=A asc&\$top=1&\$skip=7$/,
    )
    // $select is the grouping on an aggregating table, so the count takes it too; paging options it does not.
    expect(seen.countUrl()).toMatch(
      /Turnovers\(\)\/\$count\?StartPeriod=.*AccountCondition=.*&\$filter=A gt 0&\$select=A$/,
    )
  })

  it('counts a no-argument table at …/Func()/$count', async () => {
    const seen = capture('AccountingRegister_X/ExtDimensions\\(\\)', { 'odata.metadata': '#X', value: [] }, '3')
    const page = await client().register('AccountingRegister_X').extDimensions({ count: true })
    expect(page).toEqual({ value: [], count: 3 })
    expect(seen.countUrl()).toMatch(/ExtDimensions\(\)\/\$count$/)
  })

  it('fails the call when /$count fails, rather than returning rows without a count', async () => {
    capture('AccumulationRegister_X/Balance\\(\\)', { 'odata.metadata': '#X', value: [{ A: 1 }] }, { status: 400 })
    await expect(client().register('AccumulationRegister_X').balance({}, { count: true })).rejects.toThrow()
  })

  it('fails the call when /$count answers a negative number', async () => {
    capture('AccumulationRegister_X/Balance\\(\\)', { 'odata.metadata': '#X', value: [] }, '-1')
    await expect(client().register('AccumulationRegister_X').balance({}, { count: true })).rejects.toThrow(
      /non-negative/,
    )
  })

  it('aborts the page when /$count fails first', async () => {
    let pageAborted = false
    server.use(
      http.get(/\/AccumulationRegister_X\/Balance\(\)\/\$count/, () =>
        HttpResponse.json({ 'odata.error': { code: '', message: { value: 'boom' } } }, { status: 400 }),
      ),
      http.get(/\/AccumulationRegister_X\/Balance\(\)(\?.*)?$/, async ({ request }) => {
        await new Promise<void>((resolve) => {
          request.signal.addEventListener('abort', () => {
            pageAborted = true
            resolve()
          })
          setTimeout(resolve, 2000)
        })
        return HttpResponse.json({ 'odata.metadata': '#X', value: [] })
      }),
    )
    await expect(client().register('AccumulationRegister_X').balance({}, { count: true })).rejects.toThrow()
    await new Promise((r) => setTimeout(r, 50))
    expect(pageAborted).toBe(true)
  })

  it('fails the call when /$count answers something that is not a number', async () => {
    capture('AccumulationRegister_X/Balance\\(\\)', { 'odata.metadata': '#X', value: [] }, 'n/a')
    await expect(client().register('AccumulationRegister_X').balance({}, { count: true })).rejects.toThrow(/integer/)
  })

  it('sends no $orderby for an empty list, and $skip=0 as given', async () => {
    const seen = capture('AccumulationRegister_X/Balance\\(\\)')
    await client().register('AccumulationRegister_X').balance({}, { orderBy: [], top: 1, skip: 0 })
    expect(seen.pageUrl()).toMatch(/Balance\(\)\?\$top=1&\$skip=0$/)
  })

  it.each([
    ['a negative skip', { skip: -1 }],
    ['a fractional skip', { skip: 1.5 }],
    ['an orderBy that is not an array', { orderBy: 'A desc' }],
    ['an orderBy entry without a field', { orderBy: [{ dir: 'asc' }] }],
    ['an orderBy entry with a blank field', { orderBy: [{ field: '  ' }] }],
    ['an orderBy field carrying its own direction', { orderBy: [{ field: 'Сумма desc' }] }],
    ['an orderBy field carrying a second key', { orderBy: [{ field: 'A,B' }] }],
    ['an orderBy path with an empty segment', { orderBy: [{ field: 'Контрагент//ИНН' }] }],
    ['an orderBy entry with an unknown dir', { orderBy: [{ field: 'A', dir: 'down' }] }],
    ['a null orderBy entry', { orderBy: [null] }],
    ['a non-boolean count', { count: 'yes' }],
  ])('rejects %s from an untyped caller before issuing the request', async (_name, bad) => {
    await expect(
      client()
        .register('AccumulationRegister_X')
        .balance({}, bad as unknown as { skip?: number }),
    ).rejects.toThrow(InvalidArgumentError)
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
