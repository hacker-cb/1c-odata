---
"@1c-odata/mcp": patch
---

`--data-dir` and `ONEC_MCP_DATA_DIR` now accept a path starting with the home
directory — a bare `~`, `~/…`, or on Windows also `~\…` — and `resolveDataDir`
expands it via `os.homedir()`. MCP clients launch `serve` without a shell, so a
`~` in their `args` / `env` used to reach the server literally and fail as
"not absolute". The expansion happens before the keychain namespace is hashed,
so `~/x` and its absolute spelling share one directory and one set of stored
passwords. `~user/…` and `$HOME` are still not expanded and still fail, now
with a hint saying which forms are.
