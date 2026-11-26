---
"@1c-odata/client": patch
---

Documentation: `RequestEvent.signal` and `RequestHooks` now spell out what `req.signal` ends. It aborts only when its attempt is cut short (the timeout, the caller's abort, a hook's own error) — not on a response, an HTTP or network error, or when a retry replaces the attempt. Work a hook starts without awaiting it runs on past the call unless the caller's signal aborts it; the docs show how to bound it. No behaviour change.
