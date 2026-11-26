---
"@1c-odata/client": minor
---

**Breaking:** on a timeout the call no longer waits for `onError`. The hook is still called with the `TimeoutError`, but the call fails at once; what the hook throws or rejects with afterwards is dropped (handled, never an unhandled rejection). Before, the wait for `onError` was unbounded on the timeout path and on a network failure — where the timer was cleared before it — so an `onError` writing to the same hung service kept the call from ending, though `timeout` had fired.

On a network failure `onError` is now awaited for what is left of the `timeout`, and until the caller's own signal aborts: past the deadline the call fails with the `NetworkError` the hook was given — retried as one where a retry policy allows, while the outrun hook still runs — and on the caller's abort with the abort's reason. On an `HTTPError` the timeout does not bound `onError` (the exchange with 1С is over), but a caller's abort now ends the wait there too, with its reason. An `onError` whose wait ended early goes on by itself under an aborted `req.signal`, what it throws later dropped. With neither a `timeout` nor a signal every hook is awaited in full, as before. The rule for every hook — which of the timeout and a caller's abort bounds it, and what the caller gets — is now listed once, on `RequestHooks`: a caller's abort ends the wait for every hook but `afterResponse` on a buffered call.

Migration: if you relied on the call's rejection to know a side effect of `onError` had finished — a log flushed, a metric sent — await that in your own code instead (keep the promise the hook starts, and await it after catching the call's error).
