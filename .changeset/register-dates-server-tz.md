---
"@1c-odata/mcp": patch
---

MCP `register_query` reads a period without a timezone as the 1С server's time — the connection's `serverTimezone`, the same conversion the client applies to naive date-times in 1С responses. A naive date-time such as `"2026-01-01T00:00:00"` (or `"2026-01-01 00:00"`) is now accepted instead of rejected. **Behaviour change:** a bare date such as `"2026-01-01"` now means the server's midnight; it used to mean UTC midnight, which for `Europe/Moscow` sent `StartPeriod=…T03:00:00` and dropped the first three hours of the period (and pulled in the previous evening for zones west of UTC). To keep the old boundary, spell it with its zone: `"2026-01-01T00:00:00Z"`. Values with `Z` or an offset are read as before. Impossible dates (`2026-02-30`), times (`24:00`) and local times a daylight-saving switch skips are now rejected instead of silently shifted; the error message names the zone used.
