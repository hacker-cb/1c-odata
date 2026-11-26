---
"@1c-odata/client": patch
---

The filter DSL's `dateadd` and `datedifference` now refuse a unit outside their signature's list (`second`, `minute`, `hour`, `day`, `month`, `quarter`, `year`) with an `InvalidArgumentError`, instead of writing whatever untyped code passed into `$filter` unescaped.
