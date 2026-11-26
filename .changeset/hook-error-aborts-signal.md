---
"@1c-odata/client": patch
---

A hook's own error now aborts `req.signal` whether or not a `timeout` is set. Before, the signal was aborted only through the timeout's controller, so with no `timeout` the work a failing `beforeRequest` (or a streamed read's `afterResponse`) had started under `req.signal` ran on without a deadline. Every attempt now carries a controller of its own in the request signal: `req.signal` is always set for hooks — a hook falling back on `req.signal ?? AbortSignal.timeout(…)` no longer takes its fallback — and it aborts, with the hook's error as its reason, when a hook (`beforeRequest`, `afterResponse` on either path, or `onError` throwing an error other than the one it was handed) ends the call with its own error. A `beforeRequest` returning a replacement event without `signal` no longer leaves the later hooks without one. The caller's own `AbortSignal` is never aborted by this.

On a buffered call the timeout now stops once the response body is read, as documented: it no longer aborts `req.signal` under a slow `afterResponse` or `onError` after 1С has answered. And a `hooks` getter that throws after the response counts as the hook's own error — reaching the caller as is, never retried — as it already did before the request and on a streamed read.
