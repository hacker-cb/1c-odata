import type { ODataV3Client } from '@1c-odata/client'
import type { Catalog_Номенклатура } from '../../generated/default/index.js'

/**
 * Realistic catalog query against a wide entity (80+ fields).
 * Shows: typed filter DSL, .select to limit columns, .orderBy, .top.
 */
export async function listTopItems<F>(client: ODataV3Client<F>): Promise<void> {
  const { value: items } = await client
    .query<Catalog_Номенклатура>('Catalog_Номенклатура')
    .filter((f) => f.IsFolder.eq(false))
    .select('Ref_Key', 'Code', 'Description', 'Артикул')
    .orderBy('Code', 'asc')
    .top(10)
    .get()

  process.stdout.write('\nItems (top 10 non-folder by Code):\n')
  for (const it of items) {
    const code = it.Code ?? '?'
    const sku = it.Артикул ?? ''
    const desc = it.Description ?? ''
    process.stdout.write(`  ${code.padEnd(12)} | ${sku.padEnd(20)} | ${desc}\n`)
  }
}
