---
"@1c-odata/client": minor
---

**Breaking:** an exception thrown by an `afterResponse` or `onError` hook now reaches the caller as is — it is no longer wrapped in a `NetworkError`, `onError` is not called a second time with that wrapper, and retry never repeats the request because of it, whatever the exception's type (a `NetworkError` from a nested client call inside a hook included). Only a failure of the wire itself — the fetch, or reading the response body — becomes a `NetworkError`. Before, a hook that threw (say, `onError` throwing on a 401 to trigger a re-login) came back as a `NetworkError`, and with retry enabled the request was sent again — for the default `retryableMethods`, which include `PATCH`, `PUT` and `DELETE`, the write was repeated in 1С. An `onError` that rethrows the very error it was handed ("log and rethrow") leaves it the library's error, retried as before. `beforeRequest` already propagated its exceptions unchanged; all three hooks now follow one rule, stated on `RequestHooks`.

Migration: if you caught your own hook's failure as `NetworkError` (`err instanceof NetworkError`, or by its `cause`), catch the error your hook throws instead. Code that relied on retry re-sending a request after a hook threw must retry it itself.

A JSON error body of `null` — from a proxy, say — is now a `ParseError` ("missing odata.error wrapper") like any other non-object body, instead of escaping as a `TypeError` that became a retried `NetworkError`. An `odata.error.code` whose conversion to text throws no longer escapes the same way, and a bare-string `odata.error` — an empty one included — is kept as the message of an `HTTPError` rather than lost or taken for a missing wrapper.

In `requestStream()`, an `afterResponse` hook that throws now cancels the unread response body, releasing its connection, instead of leaving it to the garbage collector.
