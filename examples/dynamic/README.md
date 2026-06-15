# dynamic — no-codegen mode

Connects to a 1С base **without any generated files**: no config file, no `1c-odata fetch`, no `1c-odata generate`, no `generated/` directory. `createDynamicClient` downloads `$metadata` at startup, builds the runtime `MetadataIndex`, and returns a fully schema-aware client.

Demos (read-only):

- `schema.ts` — runtime schema introspection: entity-set counts per 1С kind, straight from the fetched index
- `currencies.ts` — untyped query with the same fluent API (`query<UntypedEntity>`, `orderBy`, `top`)
- `dates.ts` — `Edm.DateTime` fields arrive as real JS `Date` objects thanks to the runtime schema

## Run

```bash
export ONEC_EXAMPLE_DYNAMIC_URL=http://user:password@host/base/odata/standard.odata
pnpm --filter dynamic-example demo
```

(Or put the variable into `examples/dynamic/.env.local`.) Percent-encode reserved characters in credentials — see [`examples/README.md`](../README.md).

First run takes a few seconds: `$metadata` is 10+ MB on real bases. Long-lived services should cache the index instead of re-downloading — see "Schema sources" in the [root README](../../README.md#schema-sources).
