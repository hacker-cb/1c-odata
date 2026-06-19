---
"@1c-odata/client": patch
---

fix(client): don't set a manual Content-Length on write requests

The write path set an explicit `Content-Length` header (computed from the body)
on POST / PATCH / PUT. `Content-Length` is a forbidden fetch header, and undici
(Node's `fetch` backend) rejects a manual one with `UND_ERR_INVALID_ARG: invalid
content-length header` once it conflicts with the length undici derives from the
body — which surfaces on the real dispatch path, e.g. behind a `ProxyAgent` and
on undici ≥ 7. The client now sets only `Content-Type` on body writes and lets
`fetch`/undici compute `Content-Length`; a body-less write still sends an
explicit `Content-Length: 0` (1С's IIS host wants it to avoid a 411 Length
Required).
