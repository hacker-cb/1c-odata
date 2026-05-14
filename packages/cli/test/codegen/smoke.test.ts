import { describe, expect, it } from 'vitest'
import { type GenerateInput, type GenerateResult, generate } from '../../src/codegen/index.js'

describe('@1c-odata/cli/codegen public API', () => {
  it('generate() accepts options and returns a Map<string,string>', () => {
    const input: GenerateInput = {
      metadata:
        '<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">' +
        '<edmx:DataServices m:DataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">' +
        '<Schema Namespace="StandardODATA" xmlns="http://schemas.microsoft.com/ado/2009/11/edm"/>' +
        '</edmx:DataServices></edmx:Edmx>',
    }
    const result: GenerateResult = generate(input)
    expect(result.files).toBeInstanceOf(Map)
    expect(result.files.size).toBeGreaterThan(0)
    expect(result.files.has('__metadata.json')).toBe(true)
    expect(result.files.has('index.ts')).toBe(true)
  })
})
