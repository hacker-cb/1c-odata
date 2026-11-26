---
"@1c-odata/mcp": patch
---

A tool call the MCP client cancels — or one whose transport closes — now aborts its requests to 1С. `query` (its page and the parallel `/$count`), `get_entity`, `count` and `register_query` (its page and the table's `/$count`) hand the MCP request's abort signal to every request they make, so a cancelled heavy call (say, a big `register_query`) stops loading 1С instead of running to the end for a reply no one reads. Resolving the connection is left out: its `$metadata` download is shared by every call waiting on that connection, and one caller's cancel does not fail the others.
