---
"@1c-odata/client": patch
---

A hook's own error now aborts `req.signal` whether or not a `timeout` is set. Before, the signal was aborted only through the timeout's controller, so with no `timeout` the work a failing `beforeRequest` (or a streamed read's `afterResponse`) had started under `req.signal` ran on without a deadline. Every call now carries a controller of its own in the request signal: `req.signal` is always set for hooks, and it aborts when a hook — `beforeRequest`, `afterResponse` on either path, or `onError` throwing an error other than the one it was handed — ends the call with its own error. The caller's own `AbortSignal` is never aborted by this.
