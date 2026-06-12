import type { ODataV3Client, UntypedEntity } from '@1c-odata/client'

/**
 * Untyped query: same fluent API as the codegen path, entity set addressed by
 * name. `UntypedEntity` gives typed 1С system fields (`Ref_Key`, …) plus an
 * open index signature for the rest.
 */
export async function listTopCurrencies<F>(client: ODataV3Client<F>): Promise<void> {
  const { value: currencies } = await client.query<UntypedEntity>('Catalog_Валюты').orderBy('Code', 'asc').top(5).get()

  process.stdout.write('Currencies (top 5 by Code):\n')
  for (const c of currencies) {
    process.stdout.write(`  ${String(c.Code ?? '?')} — ${String(c.Description ?? '(no description)')}\n`)
  }
}
