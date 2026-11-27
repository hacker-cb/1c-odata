---
'@1c-odata/client': patch
---

An array inside an array of a response is read as an array, where the parser turned it into an object keyed `"0"`, `"1"`, …. OData V3 has no collection of collections and 1С sends none, so nothing changes for a response from 1С.
