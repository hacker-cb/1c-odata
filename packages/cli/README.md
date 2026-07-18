# @1c-odata/cli

Two binaries for [`@1c-odata/client`](https://www.npmjs.com/package/@1c-odata/client):

- `1c-odata fetch` — downloads `$metadata` (EDMX) from a 1С:Enterprise OData V3 endpoint and saves it locally.
- `1c-odata generate` — generates TypeScript types from the saved EDMX (per-target output under `generated/<target>/`).

Codegen library is also exposed at [`@1c-odata/cli/codegen`](https://github.com/hacker-cb/1c-odata/tree/master/packages/cli/src/codegen) for programmatic use.

Pure ESM. Node ≥ 24.18.0.

> ⚠️ **v0.x — pre-release.** API is unstable; see [STABILITY.md](https://github.com/hacker-cb/1c-odata/blob/master/STABILITY.md).

## Install

```bash
pnpm add -D @1c-odata/cli @1c-odata/client
```

## Quick start

`1c-odata.config.ts`:

```ts
import { parseConnectionUrl } from '@1c-odata/client'
import { defineCodegenConfig } from '@1c-odata/cli'

const url = process.env.ONEC_URL
if (!url) throw new Error('Set ONEC_URL (format: http://user:pwd@host/path)')

export default defineCodegenConfig({
  targets: {
    trade: {
      connection: {
        ...parseConnectionUrl(url),
        serverTimezone: 'Europe/Moscow',
      },
      include: ['Catalog_*', 'Document_*'],
    },
  },
})
```

Fetch + generate:

```bash
export ONEC_URL=http://u:p@1c.example.com/odata/standard.odata
pnpm 1c-odata fetch
pnpm 1c-odata generate
```

`loadConfig` auto-sources `.env` then `.env.local` (relative to cwd) before evaluating `1c-odata.config.ts`, so `process.env.ONEC_URL` resolves at config-eval time without a manual `export`.

## Commands & flags

Both commands default to **all** targets; pass `-t` to pick one.

| Command | Flags |
|---|---|
| `1c-odata fetch` | `-t, --target <name>`, `--config <path>` |
| `1c-odata generate` | `-t, --target <name>`, `--config <path>`, `-f, --force` (regenerate even when inputs are unchanged), `--metadata-only` (emit only `__metadata.json`; skips TS generation — existing `.ts` files are left untouched) |

## Config options

`defineCodegenConfig` accepts, alongside `targets`:

| Option | Default | Purpose |
|---|---|---|
| `metadataDir` | `./metadata` | where `<target>.xml` snapshots are written / read |
| `generatedDir` | `./generated` | where generated TS lands (`<target>/<kind>/<Name>.ts`) |
| `fetchTimeout` | `120_000` | `1c-odata fetch` timeout in ms (per-target override available) |

Each target is `{ connection, include?, fetchTimeout? }` — `include` is a glob whitelist of entity-type names (`Catalog_*`), and the dependency closure auto-expands.

## Programmatic use

`runFetch` / `runGenerate` / `loadConfig` are exported from `@1c-odata/cli` (and `generate` from `@1c-odata/cli/codegen`) for scripting the pipeline without the bin.

See [the repo README](https://github.com/hacker-cb/1c-odata#readme) for project-wide setup and [`examples/basic`](https://github.com/hacker-cb/1c-odata/tree/master/examples/basic) for a runnable consumer.

## License

[MIT](./LICENSE)
