import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDynamicClient } from '../../src/dynamic-client.js'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())
beforeEach(() => server.resetHandlers())

const MINI_EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
  <edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
    <Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm">
      <EntityType Name="Catalog_X">
        <Key><PropertyRef Name="Ref_Key"/></Key>
        <Property Name="Ref_Key" Type="Edm.Guid" Nullable="false"/>
        <Property Name="Date" Type="Edm.DateTime" Nullable="true"/>
        <Property Name="Code" Type="Edm.String" Nullable="false" MaxLength="3"/>
      </EntityType>
      <EntityContainer Name="StandardODATA" m:IsDefaultEntityContainer="true">
        <EntitySet Name="Catalog_X" EntityType="StandardODATA.Catalog_X"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`

const conn = {
  baseUrl: 'http://example.test/odata',
  auth: { username: 'u', password: 'p' },
  serverTimezone: 'Europe/Moscow',
}

function stubMetadata() {
  server.use(
    http.get('http://example.test/odata/$metadata', () =>
      HttpResponse.text(MINI_EDMX, { headers: { 'Content-Type': 'application/xml' } }),
    ),
  )
}

describe('createDynamicClient', () => {
  it('fetches $metadata and returns a schema-driven client (DateTime parsed via index)', async () => {
    stubMetadata()
    server.use(
      http.get('http://example.test/odata/Catalog_X', () =>
        HttpResponse.json({ 'odata.metadata': 'meta', value: [{ Ref_Key: 'a', Date: '2025-03-15T15:00:00' }] }),
      ),
    )
    const client = await createDynamicClient(conn)
    expect(client.metadataIndex?.entitySetToType['Catalog_X']).toBe('Catalog_X')
    const { value } = await client.query('Catalog_X').get()
    expect(value[0]?.Date).toBeInstanceOf(Date)
  })

  it('validateOnWrite uses the fetched schema (maxLength caught before any HTTP)', async () => {
    stubMetadata()
    const client = await createDynamicClient(conn, { validateOnWrite: true })
    await expect(client.entity('Catalog_X').create({ Code: 'TOO-LONG' })).rejects.toThrow(/Validation failed/)
  })

  it('top-level signal becomes the client umbrella signal (one signal cancels everything)', async () => {
    stubMetadata()
    server.use(
      http.get('http://example.test/odata/Catalog_X', () => HttpResponse.json({ 'odata.metadata': 'meta', value: [] })),
    )
    const controller = new AbortController()
    const client = await createDynamicClient(conn, { signal: controller.signal })
    controller.abort()
    await expect(client.query('Catalog_X').get()).rejects.toThrow()
  })
})
