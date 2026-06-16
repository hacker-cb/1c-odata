---
"@1c-odata/client": patch
"@1c-odata/metadata": patch
"@1c-odata/cli": patch
"@1c-odata/mcp": patch
---

fix(release): publish via `pnpm pack` so `workspace:*` deps are rewritten to concrete versions

The release workflow published with `npm publish`, which does not rewrite the
`workspace:` protocol. As a result `@1c-odata/metadata` and `@1c-odata/cli` (and
transitively `@1c-odata/mcp`) shipped with `"@1c-odata/client": "workspace:*"` in
their published manifests and were uninstallable from npm (`EUNSUPPORTEDPROTOCOL`).
The workflow now publishes a `pnpm pack` tarball, which rewrites workspace deps to
the released version, so a plain `npm install` / `npx` resolves them. (`@1c-odata/client`
is dependency-free and was unaffected; it bumps with the fixed group.)
