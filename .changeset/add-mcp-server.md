---
"@1c-odata/mcp": minor
---

Add `@1c-odata/mcp` — a read-only MCP (Model Context Protocol) server for 1С:Enterprise OData V3 bases, built on `@1c-odata/client` and `@1c-odata/metadata`.

- **Schema tools**: `list_connections`, `list_entities` (filter by kind/name, paginated), `describe_entity` (properties, keys, navigation, value storages), `list_enums`, `refresh_metadata`.
- **Data tools**: `query` (raw `$filter`/`$select`/`$expand`/`$orderby`, paging, optional count), `get_entity`, `count`, `register_query` (balance / turnovers / slices / accounting virtual tables, paginated via `top`/`skip`; the returned `total` is exact below the register-fetch cap, a `totalCapped` floor beyond it).
- **Bounded output**: every read tool keeps its result within a configurable byte budget — large row sets are truncated to a usable sample (with `truncated`/`hasMore` and a nudge to narrow), and oversized individual fields (e.g. a base64 `ValueStorage`) are capped with a marker, so a single fat row or entity can't overflow it either. Opt-in `compact` additionally drops 1С `*_Type` / `@odata` annotation noise. `register_query` additionally caps the rows it fetches from a register FI (degrading to a `totalCapped` floor beyond the cap). Page size, byte budget, and register-fetch cap are env-configurable (`ONEC_MCP_DEFAULT_TOP`, `ONEC_MCP_MAX_TOP`, `ONEC_MCP_MAX_BYTES`, `ONEC_MCP_MAX_REGISTER_ROWS`); results serialize as compact JSON.
- **Connection management** — CLI `1c-odata-mcp add`/`list`/`remove`/`test` (interactive no-echo password, or non-interactive via `--url`/`--login`/`--password-stdin`/env), plus MCP `add_connection`/`remove_connection` tools. Secrets resolve env → OS keychain (`@napi-rs/keyring`, optional) → `0600` file; no tool ever returns a password, and `config.json` carries none.
- Works against any base at runtime via live `$metadata` (dynamic mode); read-only by design.
