---
"@1c-odata/client": patch
---

A `beforeRequest` hook that throws no longer leaves the request's timeout timer running. The timer starts before the hook (the hook sees the timeout in `req.signal`), but its cleanup sat after it, so a failing hook — a token fetch that rejects, say — failed the call at once while the pending timer kept a short-lived Node process (a CLI, a script, a test run) alive for the whole `timeout`. The timer is now cleared when the hook throws; the hook's error still reaches the caller unchanged.
