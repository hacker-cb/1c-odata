import type { ODataV3Client, UntypedEntity } from '@1c-odata/client'

/**
 * Schema-driven value handling without codegen: thanks to the runtime
 * MetadataIndex, `Edm.DateTime` fields arrive as real JS `Date` objects
 * (converted from the server's wall-clock time via `serverTimezone`) — and a
 * `Date` in a write payload would go back as naive ISO the same way.
 */
export async function showRecentDocumentDates<F>(client: ODataV3Client<F>): Promise<void> {
  const { value: docs } = await client
    .query<UntypedEntity>('Document_РеализацияТоваровУслуг')
    .orderBy('Date', 'desc')
    .top(3)
    .get()

  process.stdout.write('Recent Document_РеализацияТоваровУслуг dates (parsed via runtime schema):\n')
  for (const d of docs) {
    const date = d.Date
    const rendered = date instanceof Date ? date.toISOString() : String(date)
    process.stdout.write(
      `  ${String(d.Number ?? d.Ref_Key)} — ${rendered} (instanceof Date: ${date instanceof Date})\n`,
    )
  }
}
