---
"@1c-odata/mcp": patch
---

Re-pointing a connection to another server without a password (`add --force`, `add_connection` with `overwrite`) no longer deletes the stored password before `config.json` is written. If the write then failed — a full disk, permissions — the connection still pointed at its server but its password was gone. The old server's password is now dropped only after the new `config.json` is saved, and a failed save leaves the connection, password included, as it was. Since a password is keyed to its server, the re-point no longer needs that deletion to succeed either: a locked keychain no longer refuses it, and a copy it keeps is never read for the new server.
