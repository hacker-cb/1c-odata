---
"@1c-odata/client": patch
---

The request timeout no longer keeps a Node process alive, and it now bounds the `beforeRequest` hook. Before, a `beforeRequest` hook that threw — a token fetch that rejects, say — failed the call at once while the timeout's timer, started before the hook, kept a short-lived process (a CLI, a script, a test run) alive for the whole `timeout`. The timer is now `unref`'d: a deadline, never the thing holding the process open. A hook that throws still fails the call with its own error, unchanged, and the timer still aborts `req.signal` at its deadline, so work the hook started under that signal stays bounded. A hook still pending when the timeout fires now fails the call with a `TimeoutError` — `onError` called with it — even where the hook ignores `req.signal`; before, the call waited for the hook however long it took, and a hook that rejected with the timeout's own abort surfaced as a bare `AbortError`.
