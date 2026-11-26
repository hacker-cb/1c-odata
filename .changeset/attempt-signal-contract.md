---
"@1c-odata/client": patch
---

Documentation: `RequestEvent.signal` and `RequestHooks` now spell out what `req.signal` ends. It aborts only when its attempt is cut short — the timeout, the call's signal (yours, or the one a register read with `count: true` adds), a hook's own error — and not on a response, an error from 1С or the network by itself, or a retry replacing the attempt. Work a hook starts without awaiting it can outlive the call; the docs say how to bound it. No behaviour change.
