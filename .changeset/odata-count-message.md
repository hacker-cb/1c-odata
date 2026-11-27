---
'@1c-odata/client': patch
---

A malformed `odata.count` that is a JSON object carrying a `"toString"` key is refused with the `ParseError` it was meant to get, not a `TypeError` raised while writing that error's message. The message now names the value's kind (`got: an object`, `got: number -1`) where it showed `String(value)`.
