---
"@1c-odata/mcp": patch
---

Overwriting a connection — `add_connection` with `overwrite`, the CLI `add --force` — no longer drops the `shape` stored for it in `config.json` (how Int64 and DateTime values come back, e.g. `int64Mode: "string"`). Neither command takes a shape, so the overwrite rebuilt the entry without it, and reads then silently returned Int64 values as `number` instead. An overwrite now keeps the stored shape, as it keeps the label, including when it re-points the connection.
