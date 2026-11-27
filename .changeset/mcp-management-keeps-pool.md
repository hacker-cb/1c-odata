---
"@1c-odata/mcp": patch
---

`add_connection`, `set_credentials` and `remove_connection` no longer drop the connection's built client from the server's pool. Since the pool compares a connection and its password with what its client was built from on every use, and rebuilds on a change, the drop only forced a needless `$metadata` download — on every label-only overwrite, too. A change still reaches the next call as before. Where a password just stored cannot be read back (a keychain refusing to read), the pool keeps using the client it has for that same server rather than failing the call.
