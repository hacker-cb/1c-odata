---
"@1c-odata/mcp": minor
---

**Breaking:** the server timezone has no default anymore. MCP `add_connection` requires `serverTimezone` — before, it was optional and defaulted to `Europe/Moscow`. The CLI `add --url …` requires `--timezone`. The interactive `add` asks for the zone without offering an answer and asks again on a blank one. The project rule is that `serverTimezone` has no implicit default: a connection added without one for a base outside Moscow time silently shifted every DateTime it read or wrote. Migration: pass `serverTimezone` (an IANA zone, e.g. `"Europe/Moscow"`) to `add_connection`, and `--timezone <zone>` to non-interactive `add`. Connections already in `config.json` are unaffected.
