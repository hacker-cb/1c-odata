---
"@1c-odata/mcp": patch
---

A running `serve` now follows a connection another process changed or removed. Before, it kept the client it had built on first use until it was restarted: after the CLI `remove`, `add --force` or `set-credentials` — or the same tools in another MCP server sharing the config — it went on answering with the old server timezone (DateTimes shifted), the old login and password, or for a connection that no longer existed. Each tool call now re-reads the connection and its password and rebuilds the client, downloading `$metadata` again, when the base URL, login, timezone, data shape or password differ from what it was built with; a removed connection fails as an unknown one, and one left without a password as password-less. A label change alone rebuilds nothing, and `list_connections` reports a connection whose cached client is outdated as not loaded.
