import { createClient } from './client.js'
import { listTopCurrencies } from './demos/currencies.js'
import { showRecentDocumentDates } from './demos/dates.js'
import { describeSchema } from './demos/schema.js'

async function main(): Promise<void> {
  const client = await createClient()
  describeSchema(client)
  await listTopCurrencies(client)
  await showRecentDocumentDates(client)
}

main().catch((err) => {
  process.stderr.write(`\nDemo failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
