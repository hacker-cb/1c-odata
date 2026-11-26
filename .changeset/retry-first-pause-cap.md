---
"@1c-odata/client": patch
---

`RetryPolicy.maxDelayMs` now caps the first pause between attempts too: an `initialDelayMs` above it went uncapped into the first pause (in full with `jitter: 'none'`, a random share of it with `'full'`).
