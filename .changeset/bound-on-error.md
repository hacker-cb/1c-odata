---
"@1c-odata/client": minor
---

**Breaking:** on a timeout the call no longer waits for `onError`. The hook is still called with the `TimeoutError`, but the call fails at once; what the hook throws or rejects with afterwards is dropped (handled, never an unhandled rejection). Before, the wait for `onError` was unbounded on the timeout path and on a network failure — where the timer was cleared before it — so an `onError` writing to the same hung service kept the call from ending, though `timeout` had fired.

On a network failure `onError` is now awaited for what is left of the `timeout`, and until the caller's own signal aborts: past the deadline the call fails with the `NetworkError` the hook was given, on the caller's abort with the abort's reason — the hook goes on by itself under an aborted `req.signal`. With neither a `timeout` nor a signal it is awaited in full, as before, and so is `onError` on an `HTTPError`: the exchange with 1С is over by then.

Migration: if you relied on the call's rejection to know a side effect of `onError` had finished — a log flushed, a metric sent — await that in your own code instead (keep the promise the hook starts, and await it after catching the call's error).
