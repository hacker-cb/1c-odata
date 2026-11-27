---
"@1c-odata/client": patch
---

The request a `beforeRequest` hook leaves is now read once, right after the hook — `method`, `url`, `headers` (each header, and the string it converts to) and `body` — and the transport reads nothing else after it: the fetch is sent with that reading, and an error reports it in `request`. A getter on the event, or on one of its headers, is read once, and one that throws — or a header value whose conversion to a string throws — is the hook's own error: the call ends with it unchanged and is not retried. Before, the event was read again later, partly outside the hook's error handling:

- a `url` getter, read at the fetch, turned its error into a `NetworkError`, and a `GET` under a retry policy was sent again — `beforeRequest` called anew; a header getter, or a header value whose conversion throws, did the same;
- a getter throwing when the error was being built replaced a `TimeoutError`, `NetworkError` or `HTTPError` with its own error, and `onError` was not called;
- a frozen event whose fields are getters on its prototype (a class instance) was sent without its headers, and later hooks got a copy whose `method`, `url` and `headers` were `undefined`;
- an event whose `signal` setter ignores the write left `afterResponse` and `onError` with the event's own signal instead of the request's;
- an `afterResponse` that left the event's `signal` getter throwing failed the call before `onError`.

`afterResponse` and `onError` are still handed the event itself — the one `beforeRequest` returned keeps its identity. Only an event that will not take the request signal (frozen, or a setter that ignores the write) is replaced by a copy: its own fields kept as they are defined (a getter copied, not called), and `method`, `url`, `headers` and `body` the request's as they were read, the headers a copy of their own.
