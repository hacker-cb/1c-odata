---
"@1c-odata/mcp-server": minor
---

Add `@1c-odata/mcp-server`: a stateful Streamable HTTP MCP server that exposes the
read-only 1С:Enterprise OData V3 tools (`query`, `get_entity`, `count`,
`list_entities`, `describe_entity`, `list_enums`, `list_connections`,
`refresh_metadata`, `register_query`, `server_info`) over HTTP. Programmatic
`createHttpServer()` returns an `http.Server`; the `1c-odata-mcp-server serve`
bin runs it over a `FileConnectionSource` from `--data-dir`. Read-only surface —
the connection-management tools are intentionally excluded. No auth yet.
