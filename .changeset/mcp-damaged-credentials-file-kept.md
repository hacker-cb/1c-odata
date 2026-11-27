---
"@1c-odata/mcp": patch
---

A `credentials.json` that cannot be read (malformed JSON, say) is no longer deleted whole when a password is removed from it or a keychain write tidies it — `remove`, a password stored in the keychain, a re-point. Since the file is read before the keychain, it holds the newest password wherever the keychain refused a write; deleting it whole silently brought older keychain copies of other connections back in their place. The operation now fails — "Could not remove a password from …credentials.json … Nothing was deleted from it" — and the file stays for you to fix, or to delete by hand.
