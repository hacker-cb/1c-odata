# @1c-odata/client

Typed runtime for the 1С:Enterprise OData V3 interface — `ODataV3Client`, query builder, filter DSL, value-storage helpers, and register helpers.

Server-side only. Pure ESM. Node ≥ 22.21.0.

> ⚠️ **v0.x — pre-release.** API is unstable; see [STABILITY.md](https://github.com/hacker-cb/1c-odata/blob/master/STABILITY.md).

## Install

```bash
pnpm add @1c-odata/client
pnpm add -D @1c-odata/cli   # generates types from $metadata
```

## Quick start

Assuming this file lives at `src/main.ts` (so `../generated/` resolves to the sibling codegen output). The runtime builds its own `Connection` — it does not import `1c-odata.config.ts` (that file is for the CLI):

```ts
import { clientOptionsFromConnection, defineConnection, parseConnectionUrl } from '@1c-odata/client'
import { and, any } from '@1c-odata/client/filter'
import { createClient } from '../generated/trade/client.js'
import type { Document_РеализацияТоваровУслуг } from '../generated/trade/index.js'

const url = process.env.ONEC_URL
if (!url) throw new Error('Set ONEC_URL')
const conn = defineConnection({ ...parseConnectionUrl(url), serverTimezone: 'Europe/Moscow' })
// `createClient` (generated) auto-loads the sibling `__metadata.json` and wires
// the `Functions` generic — DateTime / Int64 / ValueStorage handling is on.
const trade = await createClient(clientOptionsFromConnection(conn))

const { value: docs } = await trade
  .query<Document_РеализацияТоваровУслуг>('Document_РеализацияТоваровУслуг')
  .filter((f) => and(f.Date.year().eq(2025), any(f.Товары, (t) => t.Сумма.gt(10000))))
  .top(50)
  .get()
```

See [`examples/basic`](https://github.com/hacker-cb/1c-odata/tree/master/examples/basic) for a runnable end-to-end consumer, and [the repo README](https://github.com/hacker-cb/1c-odata#readme) for project-wide setup (network config, cross-platform Cyrillic filename handling, codegen flow).

## Error handling

All errors extend `ODataError`; narrow with subclasses (`HTTPError`, `BusinessError`, `ConcurrencyError`, `TimeoutError`, `ValidationError`, …):

```ts
import { HTTPError, ODataError } from '@1c-odata/client'

try {
  await trade.query('Document_РеализацияТоваровУслуг').get()
} catch (e) {
  if (e instanceof HTTPError) console.error(`HTTP ${e.status}`, e.request) // { method, url }, no headers
  else if (e instanceof ODataError) console.error(e.name, e.message)
}
```

A caller-supplied `AbortSignal` abort is rethrown as the native `AbortError` (not an `ODataError`); library-issued timeouts surface as `TimeoutError`.

## Registers

`client.register(set)` wraps 1С register virtual tables (balances / turnovers / slices). Turnover-style tables take a `{ from, to }` range; `balance()` and slices take a single `Period`:

```ts
const balance = await trade
  .register('AccumulationRegister_ТоварыНаСкладах')
  .balance({ Period: new Date('2025-01-01') })
```

See [the repo README](https://github.com/hacker-cb/1c-odata#readme) for the full error model and register reference.

## License

[MIT](./LICENSE)
