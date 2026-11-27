---
"@1c-odata/mcp": patch
---

A password written while the OS keychain refuses to store it — `add_connection`, `set_credentials`, CLI `add` and `set-credentials` — no longer lands in the `credentials.json` fallback behind an old keychain copy that could not be deleted. Reads take the keychain before the file, so once the keychain answered again the old password outranked the new one, and after a re-pointed connection it went to the new server. Now the fallback first deletes the keychain copy strictly: where that fails too, the write is refused with nothing changed ("Could not delete the stored password … from the OS keychain"), as a password-less re-point already was. `--insecure-storage`, which never reads the keychain, keeps the delete best-effort.
