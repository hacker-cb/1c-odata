---
"@1c-odata/client": patch
---

An event returned by `beforeRequest` whose `method`, `headers` or `body` getter throws now ends the call as the hook's own error: the timeout's timer is cleared and `req.signal` aborted with that error, and the call is not retried. Before, the timer was left running.
