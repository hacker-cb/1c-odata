---
"@1c-odata/client": patch
---

The request timeout now bounds the `afterResponse` hook, as it bounds `beforeRequest` since 0.9.0. On a streamed read (`readStream` for a ValueStorage / binary property), an `afterResponse` still running when the timeout fired used to return the response anyway with its body already cut by the timer, so reading it failed with a bare `AbortError` instead of a `TimeoutError`; now the call fails with a `TimeoutError` — `onError` called with it — and the unread body is cancelled.

The same rule now holds for every request: an `afterResponse` still pending when the timeout fires fails the call with a `TimeoutError` (`onError` fired), and a caller's `AbortSignal` firing while it runs ends the call with the abort's reason — even where the hook ignores `req.signal`. Before, the call waited for the hook however long it took and returned the response it had already read. A hook that settles in time, or throws its own error, behaves as before.
