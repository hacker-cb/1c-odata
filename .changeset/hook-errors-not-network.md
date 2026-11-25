---
"@1c-odata/client": minor
---

**Breaking:** an exception thrown by an `afterResponse` or `onError` hook now reaches the caller as is — it is no longer wrapped in a `NetworkError`, `onError` is not called a second time with that wrapper, and retry no longer repeats the request because of it. Only a failure of the wire itself — the fetch, or reading the response body — becomes a `NetworkError`. Before, a hook that threw (say, `onError` throwing on a 401 to trigger a re-login) came back as a `NetworkError`, and with retry enabled the request was sent again — for the default `retryableMethods`, which include `PATCH`, `PUT` and `DELETE`, the write was repeated in 1С. `beforeRequest` already behaved this way; all three hooks now follow one rule, stated on `RequestHooks`.

A JSON error body that is valid JSON but no object — `null` from a proxy, a number, a string, an array — is now a `ParseError` ("missing odata.error wrapper") instead of escaping as a `TypeError` that became a retried `NetworkError`; an `odata.error.code` that is no scalar no longer throws either.

Migration: if you caught your own hook's failure as `NetworkError` (`err instanceof NetworkError`, or by its `cause`), catch the error your hook throws instead. Code that relied on retry re-sending a request after a hook threw must retry it itself.
