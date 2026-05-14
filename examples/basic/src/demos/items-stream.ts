import type { ODataV3Client } from '@1c-odata/client'
import type { Catalog_Номенклатура } from '../../generated/default/index.js'

/**
 * Stream pagination demo: 20 items via 4 HTTP requests of 5 each.
 * `.top(20)` caps total items (logical bound), `pageSize: 5` is the per-request
 * transport size. Uses the fixed `stream()` semantics introduced alongside this
 * example refactor.
 */
export async function streamItems<F>(client: ODataV3Client<F>): Promise<void> {
  const collected: Pick<Catalog_Номенклатура, 'Code' | 'Description'>[] = []

  const iterable = client
    .query<Catalog_Номенклатура>('Catalog_Номенклатура')
    .filter((f) => f.IsFolder.eq(false))
    .select('Code', 'Description')
    .orderBy('Code', 'asc')
    .top(20)
    .stream({ pageSize: 5 })

  for await (const item of iterable) {
    collected.push({ Code: item.Code, Description: item.Description })
  }

  process.stdout.write(`\nItems via stream (collected ${collected.length} items in pages of 5):\n`)
  for (const it of collected) {
    process.stdout.write(`  ${it.Code ?? '?'} — ${it.Description ?? ''}\n`)
  }
}
