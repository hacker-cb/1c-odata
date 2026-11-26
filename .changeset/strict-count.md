---
"@1c-odata/client": patch
---

`.count()` now reads a `/$count` answer strictly: the whole body (BOM and surrounding whitespace aside) must be a non-negative decimal integer within the safe range. A body that only starts with digits — `12oops`, a proxy page, a truncated response — as well as `1.5`, `-1` or `1e3`, is a `ParseError` instead of a total read off its prefix. The `odata.count` of a collection (`withCount()`) is read by the same rule — a JSON number is taken where it is a non-negative safe integer, and any other value (`null`, `-1`, `true`) is a `ParseError` rather than a silently missing count. Register virtual tables (`count: true`) share the one parser, and the MCP server's `query`/`count` totals, which go through `.count()`, follow.
