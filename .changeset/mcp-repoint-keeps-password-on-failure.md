---
"@1c-odata/mcp": patch
---

Re-pointing a connection to another server or login without a password (the CLI `add --force`) no longer deletes the stored password before `config.json` is written. If the write then failed — a full disk, permissions — the connection still pointed at its server but its password was gone. The old password is now deleted only after the new `config.json` is saved, and a failed save leaves the connection, password included, as it was. Where the old password would still be read after the change — a login change on the same server, or a connection whose password still lives under `<name>` — that delete must succeed: where a locked keychain refuses it, `config.json` is put back and the change refused, as before. Otherwise — another server, a password keyed to its server — a locked keychain no longer refuses the re-point: the copy it keeps is never read for the new server.
