import { BasicAuth } from '@1c-odata/client'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ODataV3Client } from '../../src/index.js'
import { type MetadataIndex, ValidationError } from '../../src/validate.js'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
beforeEach(() => server.resetHandlers())

const baseUrl = 'http://example.test/odata'
const auth = BasicAuth({ username: 'u', password: 'p' })

const metadataIndex: MetadataIndex = {
  schemaNamespace: 'StandardODATA',
  schemas: {
    Catalog_X: {
      properties: {
        Ref_Key: { type: 'Edm.Guid', nullable: false },
        Code: { type: 'Edm.String', nullable: false, maxLength: 3 },
      },
    },
  },
  entitySetToType: { Catalog_X: 'Catalog_X' },
}

describe('ODataV3Client validateOnWrite', () => {
  it('throws ValidationError before network on .create()', async () => {
    const client = new ODataV3Client({
      baseUrl,
      auth,
      serverTimezone: 'Europe/Moscow',
      metadataIndex,
      validateOnWrite: true,
    })
    let networkHit = false
    server.use(
      http.post(/Catalog_X/, () => {
        networkHit = true
        return HttpResponse.json({})
      }),
    )
    await expect(
      client
        .entity<{ Ref_Key: string; Code: string }>('Catalog_X')
        .create({ Ref_Key: '00000000-0000-0000-0000-000000000001', Code: 'TOOLONG' }),
    ).rejects.toThrow(ValidationError)
    expect(networkHit).toBe(false)
  })

  it('skips validation when validateOnWrite: false (default)', async () => {
    const client = new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow', metadataIndex })
    let body: unknown
    server.use(
      http.post(/Catalog_X/, async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ Ref_Key: 'g', Code: 'TOOLONG' })
      }),
    )
    await client.entity<{ Ref_Key: string; Code: string }>('Catalog_X').create({ Ref_Key: 'g', Code: 'TOOLONG' })
    expect(body).toEqual({ Ref_Key: 'g', Code: 'TOOLONG' })
  })

  it('skips validation silently for entitySets not in entitySetToType', async () => {
    const client = new ODataV3Client({
      baseUrl,
      auth,
      serverTimezone: 'Europe/Moscow',
      metadataIndex,
      validateOnWrite: true,
    })
    let networkHit = false
    server.use(
      http.post(/Catalog_Unknown/, () => {
        networkHit = true
        return HttpResponse.json({ Ref_Key: 'g' })
      }),
    )
    await client.entity<{ Ref_Key: string }>('Catalog_Unknown').create({ Ref_Key: 'g' })
    expect(networkHit).toBe(true) // forward-compat: no schema → no validation
  })

  it('throws at construction when validateOnWrite: true but metadataIndex missing', () => {
    expect(() => new ODataV3Client({ baseUrl, auth, serverTimezone: 'Europe/Moscow', validateOnWrite: true })).toThrow(
      /metadataIndex/,
    )
  })
})

describe('validateOnWrite: Nullable="false" is not mandatory on write to 1С (#295)', () => {
  const index: MetadataIndex = {
    schemaNamespace: 'StandardODATA',
    schemas: {
      Catalog_X: {
        properties: {
          Ref_Key: { type: 'Edm.Guid', nullable: false },
          Code: { type: 'Edm.String', nullable: false, maxLength: 3 },
          Description: { type: 'Edm.String', nullable: false, maxLength: 25 },
          ДатаОплаты: { type: 'Edm.DateTime', nullable: false },
        },
      },
    },
    entitySetToType: { Catalog_X: 'Catalog_X' },
  }
  const key = '00000000-0000-0000-0000-000000000001'
  const client = (dateMode: 'date' | 'string' = 'date') =>
    new ODataV3Client({
      baseUrl,
      auth,
      serverTimezone: 'Europe/Moscow',
      metadataIndex: index,
      validateOnWrite: true,
      shape: { dateMode },
    })
  let sent: unknown[]
  beforeEach(() => {
    sent = []
    const reply = async ({ request }: { request: Request }) => {
      sent.push(await request.json())
      return HttpResponse.json({ Ref_Key: key, Code: 'Y', Description: 'd' })
    }
    server.use(http.patch(/Catalog_X/, reply), http.put(/Catalog_X/, reply), http.post(/Catalog_X/, reply))
  })

  it('create() without Ref_Key — 1С fills the key, and the other fields left out', async () => {
    await client().entity('Catalog_X').create({ Description: 'x' })
    expect(sent).toEqual([{ Description: 'x' }])
  })

  it('patch() and put() of one field', async () => {
    await client().entity('Catalog_X', key).patch({ Code: 'Y' })
    await client()
      .entity('Catalog_X', key)
      .put({ Code: 'Y' } as Record<string, unknown>)
    expect(sent).toEqual([{ Code: 'Y' }, { Code: 'Y' }])
  })

  it('a null date goes as the empty date of 1С — refused only under dateMode string, where it goes as null', async () => {
    await client()
      .entity('Catalog_X', key)
      .patch({ ДатаОплаты: null } as Record<string, unknown>)
    expect(sent).toEqual([{ ДатаОплаты: '0001-01-01T00:00:00' }])
    await expect(
      client('string')
        .entity('Catalog_X', key)
        .patch({ ДатаОплаты: null } as Record<string, unknown>),
    ).rejects.toThrow(ValidationError)
  })

  it('refuses a carried null in a non-nullable field, and a string past maxLength', async () => {
    const e = client().entity('Catalog_X', key)
    await expect(e.patch({ Code: null } as Record<string, unknown>)).rejects.toThrow(ValidationError)
    await expect(e.patch({ Code: 'TOOLONG' })).rejects.toThrow(ValidationError)
    await expect(
      client()
        .entity('Catalog_X')
        .create({ Description: null } as Record<string, unknown>),
    ).rejects.toThrow(ValidationError)
    expect(sent).toEqual([])
  })

  it('checks what is sent: a toJSON result', async () => {
    const body = { toJSON: () => ({ Code: null }) }
    await expect(
      client()
        .entity('Catalog_X', key)
        .patch(body as Record<string, unknown>),
    ).rejects.toThrow(ValidationError)
    expect(sent).toEqual([])
  })
})
