# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

TypeScript library for the 1С:Enterprise REST/OData V3 interface. Two-package pnpm + turbo monorepo:

| Package | Role |
|---|---|
| [`@1c-odata/client`](./packages/client/src) | Runtime — `ODataV3Client`, query builder, filter DSL, value-storage, errors, register helpers |
| [`@1c-odata/cli`](./packages/cli/src) | `1c-odata fetch` + `1c-odata generate` binaries; codegen library at [`@1c-odata/cli/codegen`](./packages/cli/src/codegen) |

Server-side only. Pure ESM. Node ≥ 22.21.0, pnpm ≥ 10.

[README.md](./README.md) — public-facing intro, quickstart, network configuration, cross-platform setup (Cyrillic filenames).
[STABILITY.md](./STABILITY.md) — what is and isn't covered by semver. The **public API surface** is exactly what `package.json#exports` reaches minus `@internal` JSDoc tags. JSDoc on public symbols is the canonical reference.

## Big picture

**Codegen-driven type safety.** The user writes `1c-odata.config.ts` declaring connections; the CLI fetches each base's `$metadata` (EDMX XML) into `metadata/<connection>.xml`, then emits per-connection TS in `generated/<connection>/<kind>/<Name>.ts`. The runtime `ODataV3Client` is generic over the user's emitted `Functions` type — full IDE completion against the live schema. **The schema (1С EDMX) is the single source of truth for both codegen and runtime parsing** (`DataShape` lives in [`packages/client/src/connection.ts`](./packages/client/src/connection.ts) and MUST match between layers).

**Three-tier API boundary** (enforced by `package.json#exports`):
- `@1c-odata/client` — stable surface (semver-protected per STABILITY.md)
- `@1c-odata/client/filter` — separate entrypoint for the filter DSL (`and`, `or`, `any`, `all`, `not`, `raw`)
- `@1c-odata/client/internal` — escape hatch consumed by `@1c-odata/cli` and integration tests; MAY break in minor versions

**Workspace deps via `workspace:*`.** `prepare` hook on `pnpm install` builds both packages' `dist/` automatically — running tests / typecheck on a fresh clone "just works" without an explicit build step. Don't manually run `pnpm build` unless investigating dist output.

## Commands

```bash
pnpm turbo build                       # workspace build (tsdown)
pnpm turbo typecheck                   # tsc --noEmit, all packages
pnpm turbo test:unit                   # vitest, fast, deterministic
pnpm turbo test:integration:offline    # codegen + parser against snapshots/*.xml
pnpm turbo test:e2e                    # CLI e2e (MSW-stubbed)
pnpm turbo test:integration:live       # gated on .env.local; skips cleanly without it
pnpm turbo test:integration:write      # gated on ONEC_TESTS_ALLOW_WRITES=true
pnpm turbo package:lint                # publint + arethetypeswrong

pnpm biome ci .                        # lint + format check (CI gate)
pnpm biome check --write .             # lint + format fix
pnpm snapshots:refresh                 # refresh snapshots/*.xml against live bases
pnpm changeset                         # add a release note (consumer-facing)
```

**Single test**: `pnpm -F @1c-odata/client vitest run test/unit/filter.test.ts` (or any path glob). `-F` is the pnpm filter for workspace packages; replace with `@1c-odata/cli` as needed.

**Live/write tests** need `.env.local` at repo root with `ONEC_TRADE_V11_5_URL`, `ONEC_BP_V3_0_URL`, and optionally `ONEC_TESTS_ALLOW_WRITES=true` — see [`snapshots/README.md`](./snapshots/README.md) for the full env contract. Without `.env.local` they skip cleanly.

**Git hooks** (`simple-git-hooks` via `prepare`): `pre-commit` runs `biome check --write` on staged files, `pre-push` runs `pnpm turbo typecheck`. Don't `--no-verify`.

## CI gates

[.github/workflows/ci.yml](./.github/workflows/ci.yml) runs Ubuntu + Windows matrices. Live/write/example jobs are owner-only via `repository_owner == 'hacker-cb'` gate + `head.repo.full_name` check (skips fork PRs while keeping owner-internal PRs covered). Required secrets feed `detect-secrets` upfront — missing secret fails loudly instead of silent-skipping.

Windows runner is materially slower than Linux/Mac for `tsc --noEmit` over thousands of generated `.ts` files (NTFS overhead). Tsc-validate timeouts reflect this: 90s for `trade_v11.5` (always-on), 60s for `bp_v3.0` (`CI=true || CI_RUN_BIG_FIXTURES=1`).

## Conventions

- **Cyrillic identifiers everywhere.** 1С metadata uses Russian (`Catalog_Валюты`, `ФайлХранилище`, `Document_РеализацияТоваровУслуг`). Codegen emits Cyrillic filenames. `.gitattributes` forces `eol=lf` + `UTF-8 working-tree-encoding` for `.ts`.
- **Per-tenant TLS/proxy unsupported.** Network config is process-wide via Node env vars (see README "Network configuration"). Different per-tenant config = separate Node processes.
- **`serverTimezone` is required, no default.** Wrong timezone silently shifts DateTime parsing — library forces an explicit IANA choice via `validateConnection`.
- **No backwards-compat shims in v0.x.** Public API is unstable; every break gets a release note in [GitHub Releases](https://github.com/hacker-cb/1c-odata/releases) with migration. v1.0 will switch to strict semver.

## Reference

- [`docs/1c/markdown/`](./docs/1c/markdown) — vendor docs snapshot (Russian) for 1С OData V3
- [`snapshots/README.md`](./snapshots/README.md) — test-fixture EDMX bases, refresh workflow
- [`examples/basic/README.md`](./examples/basic/README.md) — runnable end-to-end consumer
