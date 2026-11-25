---
"@1c-odata/client": patch
---

On a streamed read (`readStream` for a ValueStorage / binary property) the request timeout now bounds the `afterResponse` hook. Before, a hook still running when the timeout fired let the call return the response anyway, with its body already cut by the timer — reading it failed with a bare `AbortError` instead of a `TimeoutError`. Now the call fails with a `TimeoutError` (`onError` called with it) and the unread body is cancelled; a caller's `AbortSignal` firing while the hook runs ends the call with the abort's reason; both hold even where the hook ignores `req.signal`. A hook that throws its own error still fails the call with it, and work it left running under `req.signal` is now cancelled. Buffered calls (`get`, `create`, `patch`, …) are unchanged: their response is read before `afterResponse` runs and stands however long the hook takes — the JSDoc of `timeout` and `afterResponse` now says so.
