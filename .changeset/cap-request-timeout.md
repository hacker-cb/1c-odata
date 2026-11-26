---
"@1c-odata/client": patch
---

A `timeout` above `2³¹ − 1` ms (about 24.8 days), `Infinity` included, no longer fails the call with a `TimeoutError` almost at once: it is capped at that limit, the longest delay a Node timer keeps, as the retry pause already was. `TimeoutError.timeoutMs` reports the capped value. `0`, a negative value and `NaN` still disable the timeout.
