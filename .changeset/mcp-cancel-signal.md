---
"@1c-odata/mcp": patch
---

A tool call the MCP client cancels (`notifications/cancelled`) now aborts its HTTP requests to 1С. `query` (its page and the parallel `/$count`), `get_entity`, `count` and `register_query` (its page and the table's `/$count`) hand the MCP request's abort signal to every request they make, so a cancelled heavy call (say, a big `register_query`) drops its connections to 1С instead of holding them open to the end for a reply no one reads. Whether 1С stops computing a request whose connection dropped is up to the 1С server and the web server in front of it. Resolving the connection is left out: its `$metadata` download is shared by every call waiting on that connection, and one caller's cancel does not fail the others.
