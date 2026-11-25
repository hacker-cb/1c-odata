---
"@1c-odata/client": patch
---

An XML error body now counts as an OData error envelope only when its root is an `error` element in the OData metadata namespace (`http://schemas.microsoft.com/ado/2007/08/dataservices/metadata`), with `code` and `message` read from its own children. Before, any non-2xx body with `xml` in its content type that held a bare `<code>` or `<message>` anywhere was taken for one — an XHTML proxy or IIS error page with an HTML `<code>` element on a 401 became a `PermissionError` with a made-up OData code, and on a 403 an `HTTPError` with `errorFormat: 'xml'`; such pages now take the no-envelope path (`errorFormat: 'none'`, the page in `rawBody`), like any HTML error page.

The real 1С XML envelope is now recognised: 1С sends it prefixed — `<m:error xmlns:m="…"><m:code>9</m:code><m:message>…</m:message></m:error>` — which the old check missed, so it came out as `errorFormat: 'none'`. It now yields `errorFormat: 'xml'`, its `code` and `odata`, and the category subclass its status calls for (`PermissionError` on 401, `ConcurrencyError` on 412, `BusinessError` on 500 with code `-1`). The client asks for JSON, so this reaches you where a request asks for XML — a `beforeRequest` hook overriding `Accept`, or `$metadata` (`fetchMetadataXml`).
