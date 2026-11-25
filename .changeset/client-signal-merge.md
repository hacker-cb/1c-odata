---
"@1c-odata/client": patch
---

`ClientOptions.signal` now aborts every request of the client, as documented — a call given its own `signal` included. Before, a per-call `signal` replaced the client's instead of being combined with it, so stopping a service through the client's signal left such calls running; `register().*({ count: true })`, which always passes a signal of its own to the page and `/$count` requests, was never stopped by the client's signal at all. And the pause between retry attempts now hears an abort — of the call's signal or the client's: the call ends at once with the abort's reason, and no next attempt starts, so `beforeRequest` (a token refresh, say) is no longer called on an aborted request. A request whose signal has already aborted when it starts likewise ends before `beforeRequest` is called.
