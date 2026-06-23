---
"@1c-odata/mcp": patch
---

mcp: print help on a bare CLI invocation instead of silently starting the server

`1c-odata-mcp` with no subcommand now prints its help (the command list) instead
of starting the stdio MCP server, which — when run by a human in a terminal —
just hung waiting for JSON-RPC on stdin with no indication of what it was doing.
The server is now reached only via the explicit `serve` subcommand, which is how
MCP clients already launch it (`args: ["-y", "@1c-odata/mcp", "serve"]` — see the
README). Standard client configs are unaffected; only a bare `1c-odata-mcp` used
as a server entrypoint needs `serve` appended.
