---
"@1c-odata/cli": minor
---

`1c-odata generate --metadata-only` emits just `__metadata.json` (no TypeScript files) — a pinned runtime schema for `validateOnWrite` / date / Int64 parsing without generating thousands of types and without fetching `$metadata` at process startup. The flag participates in the smart-skip input hash, so switching modes regenerates correctly.
