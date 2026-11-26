---
"@1c-odata/client": patch
---

The filter DSL's `dateadd` amount and `substring` start and length must now be integers — 1С takes nothing else there: a fraction such as `dateadd('day', 0.5)` is an `InvalidArgumentError` naming the argument, instead of a query the server rejects.
