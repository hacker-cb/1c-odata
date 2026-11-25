---
"@1c-odata/mcp": minor
---

New read-only tools `download_attached_file` and `download_value_storage` save binary content from 1С to disk and return the path, size and SHA-256 instead of the bytes. `download_attached_file` follows the БСП chain (file card → `InformationRegister_ХранилищеФайлов` → `Catalog_ХранилищеДвоичныхДанных.ДвоичныеДанные`, with the card's `ФайлХранилище` as a fallback) and checks the size and hash against 1С. Files are written only inside `ONEC_MCP_DOWNLOAD_DIR` (default `<data dir>/downloads`), one folder per connection.
