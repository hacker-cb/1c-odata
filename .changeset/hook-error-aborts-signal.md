---
"@1c-odata/client": patch
---

A hook's own error now aborts `req.signal` whether or not a `timeout` is set. Before, the signal was aborted only through the timeout's controller, so with no `timeout` the work a failing `beforeRequest` (or a streamed read's `afterResponse`) had started under `req.signal` ran on without a deadline. Every attempt now carries a controller of its own in the request signal: `req.signal` is always set for hooks, and it aborts — the hook's error its reason — when a hook (`beforeRequest`, `afterResponse` on either path, or `onError` throwing an error other than the one it was handed) ends the call with its own error. A `beforeRequest` returning an event without `signal`, or deleting it, no longer leaves the later hooks without one. The caller's own `AbortSignal` is never aborted by this.

A hook that fell back on a deadline of its own where `req.signal` was missing — `req.signal ?? AbortSignal.timeout(5000)` — no longer takes the fallback. To keep that deadline, combine the two: `AbortSignal.any([req.signal, AbortSignal.timeout(5000)])`.

Once 1С has answered and the body is read, the timeout stops — on a buffered call, and for the error body of a streamed read — so it no longer aborts `req.signal` under a slow `afterResponse` or `onError` after the exchange is over. A `hooks` getter that throws after the response counts as the hook's own error — reaching the caller as is, never retried — as it already did before the request.
