import type { ODataV3Client } from '@1c-odata/client'
import type { Catalog_Валюты } from '../../generated/default/index.js'

/**
 * Simplest demo: top 5 currencies by Code.
 * Shows: typed query<T>, .orderBy, .top, .get; reading nullable fields.
 */
export async function listTopCurrencies<F>(client: ODataV3Client<F>): Promise<void> {
  const { value: currencies } = await client.query<Catalog_Валюты>('Catalog_Валюты').orderBy('Code', 'asc').top(5).get()

  process.stdout.write('Currencies (top 5 by Code):\n')
  for (const c of currencies) {
    process.stdout.write(`  ${c.Code ?? '?'} — ${c.Description ?? '(no description)'}\n`)
  }
}
