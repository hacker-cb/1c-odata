import { BasicAuth, InvalidArgumentError, type MetadataIndex, ODataV3Client } from '@1c-odata/client'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
beforeEach(() => server.resetHandlers())

const baseUrl = 'http://example.test/odata'
const auth = BasicAuth({ username: 'u', password: 'p' })

describe('readStream', () => {
  it('GET <entity>/<prop>/$value returns body + contentType', async () => {
    server.use(
      // NOTE: regex matcher — MSW's path-to-regexp interprets `(` in string
      // templates as parameter syntax, so a string template never matches a
      // URL containing parens (e.g. `Catalog_Файлы(guid'00000000-0000-0000-0000-00000000000a')`). Cyrillic
      // segment names are URL-encoded by `buildV3KeyUrl`, so the regex is
      // matched against the encoded form.
      http.get(
        /Catalog_%D0%A4%D0%B0%D0%B9%D0%BB%D1%8B\(guid'00000000-0000-0000-0000-00000000000a'\)\/%D0%A4%D0%B0%D0%B9%D0%BB%D0%A5%D1%80%D0%B0%D0%BD%D0%B8%D0%BB%D0%B8%D1%89%D0%B5\/\$value/,
        () => {
          return new HttpResponse(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
            status: 200,
            headers: { 'Content-Type': 'image/jpeg' },
          })
        },
      ),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const stream = await c.entity('Catalog_Файлы', '00000000-0000-0000-0000-00000000000a').readStream('ФайлХранилище')
    expect(stream.contentType).toBe('image/jpeg')
    const reader = stream.body.getReader()
    const chunk = await reader.read()
    expect(chunk.value).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))
  })

  it('readStream surfaces server contentType + body even for empty payload', async () => {
    // Server explicitly sends application/octet-stream and a 1-byte payload.
    server.use(
      http.get(
        /Catalog_%D0%A4%D0%B0%D0%B9%D0%BB%D1%8B\(guid'00000000-0000-0000-0000-00000000000a'\)\/X\/\$value/,
        () => {
          return new HttpResponse(new Uint8Array([0]), {
            status: 200,
            headers: { 'Content-Type': 'application/octet-stream' },
          })
        },
      ),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    const stream = await c.entity('Catalog_Файлы', '00000000-0000-0000-0000-00000000000a').readStream('X')
    expect(stream.contentType).toBe('application/octet-stream')
    expect(stream.body).toBeDefined()
  })
})

describe('writeStream', () => {
  it('PATCHes the entity with <prop>_Type and <prop>_Base64Data fields', async () => {
    let received: unknown
    server.use(
      // NOTE: regex matcher — see readStream above for rationale. The Cyrillic
      // entity-set name is URL-encoded by `buildV3KeyUrl`.
      http.patch(
        /Catalog_%D0%A4%D0%B0%D0%B9%D0%BB%D1%8B\(guid'00000000-0000-0000-0000-00000000000a'\)/,
        async ({ request }) => {
          received = await request.json()
          return HttpResponse.json({
            'odata.metadata': `${baseUrl}/$metadata#Catalog_Файлы/@Element`,
            Ref_Key: 'g',
          })
        },
      ),
    )
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await c.entity('Catalog_Файлы', '00000000-0000-0000-0000-00000000000a').writeStream('ФайлХранилище', {
      contentType: 'image/jpeg',
      base64Data: 'AQID',
    })
    expect(received).toEqual({
      ФайлХранилище_Type: 'image/jpeg',
      ФайлХранилище_Base64Data: 'AQID',
    })
  })
})

describe('ValueStorage property as one 1С name', () => {
  it.each(['A B', 'X/../Y', ''])('rejects the property %j before any request', async (prop) => {
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
    await expect(c.entity('Catalog_Файлы', '00000000-0000-0000-0000-00000000000a').readStream(prop)).rejects.toThrow(
      InvalidArgumentError,
    )
  })
})

describe('a read whose reply carries a ValueStorage asks for minimalmetadata (#289)', () => {
  const metadataIndex: MetadataIndex = {
    schemaNamespace: 'StandardODATA',
    schemas: {
      Catalog_Файлы: {
        properties: {
          Ref_Key: { type: 'Edm.Guid', nullable: false },
          ФайлХранилище_Base64Data: { type: 'Edm.Binary', nullable: true },
          ФайлХранилище_Type: { type: 'Edm.String', nullable: true },
        },
        valueStorages: ['ФайлХранилище'],
      },
      Catalog_X: { properties: { Ref_Key: { type: 'Edm.Guid', nullable: false } } },
    },
    entitySetToType: { Catalog_Файлы: 'Catalog_Файлы', Catalog_X: 'Catalog_X' },
  }
  const MINIMAL = 'application/json;odata=minimalmetadata'
  const NONE = 'application/json;odata=nometadata'
  // What 1С sends in minimalmetadata: `odata.metadata`, the storage's `_Type`, a link per navigation.
  const row = {
    Ref_Key: '00000000-0000-0000-0000-00000000000a',
    'Владелец@navigationLinkUrl': "Catalog_Файлы(guid'00000000-0000-0000-0000-00000000000a')/Владелец",
    ФайлХранилище_Type: 'image/png',
    ФайлХранилище_Base64Data: 'aGk=',
  }
  /** `[method, $format, Accept]` of each request. */
  const seen: [string, string | null, string | null][] = []
  beforeEach(() => {
    seen.length = 0
    const record = (request: Request) => {
      seen.push([request.method, new URL(request.url).searchParams.get('$format'), request.headers.get('accept')])
    }
    const single = () => HttpResponse.json({ 'odata.metadata': `${baseUrl}/$metadata#Catalog_Файлы/@Element`, ...row })
    server.use(
      http.get(/Catalog_(%D0%A4%D0%B0%D0%B9%D0%BB%D1%8B|X)$/, ({ request }) => {
        record(request)
        return HttpResponse.json({ 'odata.metadata': `${baseUrl}/$metadata#Catalog_Файлы`, value: [row] })
      }),
      http.get(/Catalog_%D0%A4%D0%B0%D0%B9%D0%BB%D1%8B\(/, ({ request }) => {
        record(request)
        return single()
      }),
      http.post(/Catalog_%D0%A4%D0%B0%D0%B9%D0%BB%D1%8B$/, ({ request }) => {
        record(request)
        return single()
      }),
      http.patch(/Catalog_%D0%A4%D0%B0%D0%B9%D0%BB%D1%8B\(/, ({ request }) => {
        record(request)
        return single()
      }),
    )
  })
  const client = (index?: MetadataIndex) =>
    new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow', ...(index ? { metadataIndex: index } : {}) })
  const grouped = {
    Ref_Key: '00000000-0000-0000-0000-00000000000a',
    ФайлХранилище: { contentType: 'image/png', base64Data: 'aGk=' },
  }

  it('reads a set with a storage in minimalmetadata — $format and Accept — and groups it, links dropped', async () => {
    const r = await client(metadataIndex).query('Catalog_Файлы').get()
    expect(seen).toEqual([['GET', MINIMAL, MINIMAL]])
    expect(r.value).toEqual([grouped])
    expect(r.odataMetadata).toContain('$metadata#Catalog_Файлы')
  })

  it('reads an entity, and the entity create() / patch() return, of such a type in minimalmetadata', async () => {
    const e = client(metadataIndex).entity('Catalog_Файлы', '00000000-0000-0000-0000-00000000000a')
    expect(await e.get()).toEqual(grouped)
    expect(await e.patch({})).toEqual(grouped)
    expect(await client(metadataIndex).entity('Catalog_Файлы').create({})).toEqual(grouped)
    expect(seen).toEqual([
      ['GET', MINIMAL, MINIMAL],
      ['PATCH', MINIMAL, MINIMAL],
      ['POST', null, MINIMAL],
    ])
  })

  it('keeps minimalmetadata on create() over a withHeader(Accept), and raw() in nometadata', async () => {
    await client(metadataIndex).entity('Catalog_Файлы').withHeader('accept', NONE).create({})
    await client(metadataIndex).query('Catalog_Файлы').raw()
    expect(seen).toEqual([
      ['POST', null, MINIMAL],
      ['GET', NONE, NONE],
    ])
  })

  it('stays nometadata for a set without storages, a $select without them, and without an index', async () => {
    await client(metadataIndex).query('Catalog_X').get()
    await client(metadataIndex).query('Catalog_Файлы').select('Ref_Key').get()
    await client().query('Catalog_Файлы').get()
    expect(seen).toEqual(Array(3).fill(['GET', NONE, NONE]))
  })
})

describe('select() of a ValueStorage field asks 1С for its halves (#286)', () => {
  const metadataIndex: MetadataIndex = {
    schemaNamespace: 'StandardODATA',
    schemas: {
      Catalog_Файлы: {
        properties: {
          Ref_Key: { type: 'Edm.Guid', nullable: false },
          ФайлХранилище: { type: 'Edm.Stream', nullable: true },
          ФайлХранилище_Base64Data: { type: 'Edm.Binary', nullable: true },
          ФайлХранилище_Type: { type: 'Edm.String', nullable: true },
        },
        valueStorages: ['ФайлХранилище'],
      },
    },
    entitySetToType: { Catalog_Файлы: 'Catalog_Файлы' },
  }
  /** The `$select` each request carried, decoded. */
  const seen: (string | null)[] = []
  beforeEach(() => {
    seen.length = 0
    server.use(
      http.get(/Catalog_%D0%A4%D0%B0%D0%B9%D0%BB%D1%8B\/\$count/, ({ request }) => {
        seen.push(new URL(request.url).searchParams.get('$select'))
        return new HttpResponse('1', { headers: { 'Content-Type': 'text/plain' } })
      }),
      http.get(/Catalog_%D0%A4%D0%B0%D0%B9%D0%BB%D1%8B$/, ({ request }) => {
        seen.push(new URL(request.url).searchParams.get('$select'))
        return HttpResponse.json({
          value: [{ Ref_Key: 'g', ФайлХранилище_Base64Data: 'aGk=', ФайлХранилище_Type: 'image/png' }],
        })
      }),
    )
  })

  it('writes the field as its two halves and reads them back grouped', async () => {
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow', metadataIndex })
    const r = await c.query<Record<string, unknown>>('Catalog_Файлы').select('Ref_Key', 'ФайлХранилище').get()
    expect(seen).toEqual(['Ref_Key,ФайлХранилище_Base64Data,ФайлХранилище_Type'])
    expect(r.value[0]).toEqual({ Ref_Key: 'g', ФайлХранилище: { contentType: 'image/png', base64Data: 'aGk=' } })
  })

  it('names a half once where the select already names it; count() sends the same $select, raw() the one given', async () => {
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow', metadataIndex })
    const q = c.query('Catalog_Файлы').select('ФайлХранилище_Type', 'ФайлХранилище')
    await q.get()
    await q.count()
    await q.raw()
    expect(seen).toEqual([
      'ФайлХранилище_Type,ФайлХранилище_Base64Data',
      'ФайлХранилище_Type,ФайлХранилище_Base64Data',
      'ФайлХранилище_Type,ФайлХранилище',
    ])
  })

  it('reads the reply of an untrimmed name in minimalmetadata, as the $select it sends', async () => {
    const formats: (string | null)[] = []
    server.use(
      http.get(/Catalog_%D0%A4%D0%B0%D0%B9%D0%BB%D1%8B$/, ({ request }) => {
        const url = new URL(request.url)
        seen.push(url.searchParams.get('$select'))
        formats.push(url.searchParams.get('$format'))
        return HttpResponse.json({ value: [] })
      }),
    )
    await new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow', metadataIndex })
      .query('Catalog_Файлы')
      .select(' ФайлХранилище ')
      .get()
    expect(seen).toEqual(['ФайлХранилище_Base64Data,ФайлХранилище_Type'])
    expect(formats).toEqual(['application/json;odata=minimalmetadata'])
  })

  it('reads an entry holding several names as 1С does', async () => {
    await new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow', metadataIndex })
      .query('Catalog_Файлы')
      .select('Ref_Key, ФайлХранилище')
      .get()
    expect(seen).toEqual(['Ref_Key,ФайлХранилище_Base64Data,ФайлХранилище_Type'])
  })

  it('sends the names as given without an index, or for a set it does not list', async () => {
    await new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow' })
      .query('Catalog_Файлы')
      .select('ФайлХранилище')
      .get()
    const other: MetadataIndex = { ...metadataIndex, entitySetToType: {} }
    await new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow', metadataIndex: other })
      .query('Catalog_Файлы')
      .select('ФайлХранилище')
      .get()
    expect(seen).toEqual(['ФайлХранилище', 'ФайлХранилище'])
  })
})

describe('a ValueStorage read back is written by its halves, in every dateMode (#293)', () => {
  const metadataIndex: MetadataIndex = {
    schemaNamespace: 'StandardODATA',
    schemas: {
      Catalog_Файлы: {
        properties: {
          Ref_Key: { type: 'Edm.Guid', nullable: false },
          Дата: { type: 'Edm.DateTime', nullable: true },
          ФайлХранилище: { type: 'Edm.Stream', nullable: true },
          ФайлХранилище_Base64Data: { type: 'Edm.Binary', nullable: true },
          ФайлХранилище_Type: { type: 'Edm.String', nullable: true },
        },
        valueStorages: ['ФайлХранилище'],
      },
    },
    entitySetToType: { Catalog_Файлы: 'Catalog_Файлы' },
  }
  let received: unknown
  beforeEach(() => {
    received = undefined
    server.use(
      http.patch(/Catalog_%D0%A4%D0%B0%D0%B9%D0%BB%D1%8B\(/, async ({ request }) => {
        received = await request.json()
        return HttpResponse.json({ Ref_Key: '00000000-0000-0000-0000-00000000000a' })
      }),
    )
  })

  it.each(['date', 'string'] as const)(
    'dateMode %s: the grouped value goes as `_Type` + `_Base64Data`',
    async (dateMode) => {
      const c = new ODataV3Client({
        baseUrl,
        auth,
        serverTimezone: 'Europe/Moscow',
        metadataIndex,
        shape: { dateMode },
      })
      await c.entity('Catalog_Файлы', '00000000-0000-0000-0000-00000000000a').patch({
        Дата: '2025-03-15T00:00:00',
        ФайлХранилище: { contentType: 'image/png', base64Data: 'aGk=' },
      })
      expect(received).toEqual({
        Дата: '2025-03-15T00:00:00',
        ФайлХранилище_Type: 'image/png',
        ФайлХранилище_Base64Data: 'aGk=',
      })
    },
  )

  it('a null storage goes as `_Base64Data: null`; a half named beside a stale value wins', async () => {
    const c = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow', metadataIndex })
    const e = c.entity('Catalog_Файлы', '00000000-0000-0000-0000-00000000000a')
    await e.patch({ ФайлХранилище: null })
    expect(received).toEqual({ ФайлХранилище_Base64Data: null })
    await e.patch({
      ФайлХранилище: { contentType: 'image/png', base64Data: 'b2xk' },
      ФайлХранилище_Base64Data: 'bmV3',
    } as Record<string, unknown>)
    expect(received).toEqual({ ФайлХранилище_Base64Data: 'bmV3' })
  })
})
