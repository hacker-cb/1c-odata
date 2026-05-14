import { BasicAuth, type MetadataIndex, ODataV3Client, ValidationError } from '@1c-odata/client'
import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generate } from '../../../src/codegen/index.js'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

const baseUrl = 'http://example.test/odata'
const auth = BasicAuth({ username: 'u', password: 'p' })

const EDMX = `<?xml version="1.0"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <EntityType Name="Catalog_X">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
        <Property Name="Code" Type="Edm.String" Nullable="false" MaxLength="3"/>
      </EntityType>
      <EntityContainer Name="StandardODATA" m:IsDefaultEntityContainer="true">
        <EntitySet Name="Catalog_X" EntityType="StandardODATA.Catalog_X"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`

describe('integration: codegen __metadata.json -> v3 validateOnWrite', () => {
  it('catches oversized string before network', async () => {
    const r = generate({ metadata: EDMX })
    const meta = JSON.parse(r.files.get('__metadata.json') ?? '{}') as {
      schemas: Record<string, unknown>
      entitySetToType: Record<string, string>
    }

    expect(meta.schemas.Catalog_X).toBeDefined()
    expect(meta.entitySetToType.Catalog_X).toBe('Catalog_X')

    const client = new ODataV3Client({
      baseUrl,
      auth,
      serverTimezone: 'Europe/Moscow',
      metadataIndex: meta as unknown as MetadataIndex,
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
})
