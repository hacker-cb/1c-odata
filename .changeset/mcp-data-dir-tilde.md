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

On Windows a drive-relative override such as `\onec` is now rejected: it passed
the absolute-path check yet resolved against whichever drive the process
started on, so the CLI and an MCP client could read different directories and
keychain namespaces. Use a drive letter (`C:\onec`) or a UNC path. An unknown
home directory on the default path now fails with the usual `resolveDataDir`
error instead of a raw `os.homedir()` exception.
