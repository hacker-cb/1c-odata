---
"@1c-odata/client": patch
---

`RetryPolicy.maxDelayMs` now caps the first pause between attempts too: an `initialDelayMs` above it waited in full before the first retry.
