---
"@1c-odata/mcp": minor
---

Add `@1c-odata/mcp` — a read-only MCP (Model Context Protocol) server for 1С:Enterprise OData V3 bases, built on `@1c-odata/client` and `@1c-odata/metadata`.

- **Schema tools**: `list_connections`, `list_entities` (filter by kind/name, paginated), `describe_entity` (properties, keys, navigation, value storages), `list_enums`, `refresh_metadata`.
- **Data tools**: `query` (raw `$filter`/`$select`/`$expand`/`$orderby`, paging, optional count), `get_entity`, `count`, `register_query` (balance / turnovers / slices / accounting virtual tables).
- **Connection management CLI** (`1c-odata-mcp add`/`list`/`remove`/`test`) with no-echo password entry. Secrets resolve env → OS keychain (`@napi-rs/keyring`, optional) → `0600` file; passwords never reach the LLM or `config.json`.
- Works against any base at runtime via live `$metadata` (dynamic mode); read-only by design.
