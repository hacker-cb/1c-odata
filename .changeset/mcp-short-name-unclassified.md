---
'@1c-odata/mcp': patch
---

`list_entities` and `describe_entity` keep the whole name of an entity type of no known kind, where they cut it at its first underscore (`__proto__` → `_proto__`) — and `list_entities` with `name` missed it. Every 1С type has a kind, so nothing changes for a 1С base.
