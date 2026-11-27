---
"@1c-odata/mcp": patch
---

- The interactive `1c-odata-mcp add` (without `--url`) no longer asks whether to overwrite an existing connection when `--force` is given; `--force` overwrites without prompting, as in the non-interactive add.
- The warning on falling back to the plaintext `credentials.json` says "@napi-rs/keyring not installed" only where the package is missing; where it is installed but fails to load — a native binary for another platform or Node version — it names the error ("could not be loaded (…)"), which reinstalling fixes.
- A `config.json` written as an array — at the top level, or as its `connections` — is refused with an error naming the file, instead of being read as connections named `0`, `1`, … or as none, which the next change then saved over.
