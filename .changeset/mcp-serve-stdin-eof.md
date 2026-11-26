---
"@1c-odata/mcp": patch
---

`1c-odata-mcp serve` now exits once the MCP client closes its end of stdin (EOF, or the stream closing). Before, the server never noticed: a call the client had abandoned kept its requests to 1С open until 1С answered, and the process stayed up meanwhile. Now the end of stdin closes the server, which aborts every tool call still running together with its requests to 1С (as a cancel does), and the connection pool aborts the `$metadata` downloads in flight — those no single call's cancel aborts, being shared by every call waiting on the connection. `runServe()` now resolves when the server closes, as its documentation said, instead of right after it starts. `ConnectionPool` (from `@1c-odata/mcp/internal`) gains `close()`, which aborts its `$metadata` downloads in flight and fails any later one, for a host shutting the pool down with its server; entries already built stay usable.
