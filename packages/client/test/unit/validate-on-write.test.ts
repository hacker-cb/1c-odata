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
