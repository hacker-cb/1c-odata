import { createClient } from './client.js'
import { listTopCurrencies } from './demos/currencies.js'
import { listTopItems } from './demos/items.js'
import { streamItems } from './demos/items-stream.js'

async function main(): Promise<void> {
  const client = await createClient()
  await listTopCurrencies(client)
  await listTopItems(client)
  await streamItems(client)
}

main().catch((err) => {
  process.stderr.write(`\nDemo failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
