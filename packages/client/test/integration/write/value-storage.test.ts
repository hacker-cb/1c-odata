import { BusinessError } from '@1c-odata/client'
import { beforeAll, describe, expect, it } from 'vitest'
import { activeFixtures, makeClient, writesAllowed } from '../helpers.js'

for (const { fixture, profile } of activeFixtures()) {
  describe.skipIf(!writesAllowed() || !profile.valueStorage)(`live write ValueStorage: ${fixture.id}`, () => {
    // biome-ignore lint/style/noNonNullAssertion: gated by describe.skipIf above
    const vs = profile.valueStorage!
    let client: ReturnType<typeof makeClient>

    beforeAll(() => {
      client = makeClient(fixture)
    })

    it('round-trips a small base64 payload through writeStream + readStream', async () => {
      // Find any existing record in the configured catalog
      const list = await client.query<{ Ref_Key: string }>(vs.catalogName).top(1).get({ timeout: 30_000 })
      if (list.value.length === 0) {
        // No file records — log and skip rather than create one (the catalog often
        // requires upstream metadata we cannot synthesize safely). Logging makes
        // "passed but did nothing" visible in CI output.
        console.warn(`[value-storage] no records in ${vs.catalogName} on ${fixture.id} — skipping round-trip`)
        return
      }
      // biome-ignore lint/style/noNonNullAssertion: list.value.length checked above
      const refKey = list.value[0]!.Ref_Key

      // Read original payload + content type (so we can restore them)
      const original = await client.entity(vs.catalogName, refKey).readStream(vs.field, {
        timeout: 30_000,
      })
      const originalContentType = original.contentType
      const originalBytes = await drain(original.body)
      const originalBase64 = Buffer.from(originalBytes).toString('base64')

      // Write a small new payload. The 1С server may run a `ПередЗаписью`
      // handler that rejects the write based on the existing record's other
      // metadata (e.g. empty Владелец) — that surfaces as BusinessError. The
      // record we picked via `top(1)` is arbitrary, so we treat such a
      // server-side reject as "this record is unsuitable for the round-trip"
      // and skip with a log, same pattern as the empty-list early-return.
      const testBytes = new Uint8Array([0x54, 0x45, 0x53, 0x54]) // 'TEST'
      const testBase64 = Buffer.from(testBytes).toString('base64')
      let writeSucceeded = false
      try {
        try {
          await client.entity(vs.catalogName, refKey).writeStream(
            vs.field,
            {
              contentType: 'application/octet-stream',
              base64Data: testBase64,
            },
            { timeout: 30_000 },
          )
          writeSucceeded = true
        } catch (err) {
          if (err instanceof BusinessError) {
            console.warn(
              `[value-storage] server rejected writeStream on ${vs.catalogName}/${refKey} on ${fixture.id} (${err.message}) — skipping round-trip`,
            )
            return
          }
          throw err
        }

        // Read it back
        const written = await client.entity(vs.catalogName, refKey).readStream(vs.field, {
          timeout: 30_000,
        })
        const writtenBytes = await drain(written.body)
        expect(Array.from(writtenBytes)).toEqual([0x54, 0x45, 0x53, 0x54])
      } finally {
        // Restore original payload (best-effort) only if our write actually
        // landed — otherwise the original state is already intact and the
        // restore is a wasted round-trip (and may fail with the same
        // BusinessError that rejected our write).
        if (writeSucceeded && originalContentType !== null) {
          await client
            .entity(vs.catalogName, refKey)
            .writeStream(
              vs.field,
              { contentType: originalContentType, base64Data: originalBase64 },
              { timeout: 30_000 },
            )
            .catch(() => {})
        }
      }
    }, 120_000)
  })
}

async function drain(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) chunks.push(value)
  }
  return concat(chunks)
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}
