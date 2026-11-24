---
"@1c-odata/client": patch
"@1c-odata/mcp": patch
---

IIS's `400 Bad Request — Invalid URL` page now gets its own message instead of the generic "no OData error envelope" text. Where a decoded path segment of the request is over 260 characters (http.sys `UrlSegmentMaxLength`) the message names that limit and the usual cause — a register virtual table called with its parameters in the path, `…/Turnovers(StartPeriod=…,AccountCondition='…')`, where they all share one segment (about two GUIDs in a condition) — and points to `client.register(…)` / MCP `register_query`, which send them in the query string with no such limit, or to splitting the condition. The MCP `query` tool's description and its virtual-table tip say the same; `register_query` is not affected by the limit.
