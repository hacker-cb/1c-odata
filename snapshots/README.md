# Snapshots

EDMX metadata snapshots for verified test fixtures. Used by offline integration tests in `packages/cli/test/codegen/integration/` and `packages/client/test/integration/`.

| File | Fixture | Configuration | Size | EntityType | ComplexType | EnumType | NavProperty | FunctionImport | Updated |
|---|---|---|---|---|---|---|---|---|---|
| `trade_v11.5.xml` | `trade_v11.5` | УТ 11.5 | 15 MB | 3841 | 1530 | 953 | 8547 | 2329 | 2026-05-05 |
| `bp_v3.0.xml` | `bp_v3.0` | БП 3.0 | 14 MB | 3697 | 1549 | 873 | 5553 | 2457 | 2026-05-05 |

Numbers cross-checked against spec §2.2 — exact match.

## Refreshing

When a test fixture's 1С publication composition changes (`УстановитьСоставСтандартногоИнтерфейсаOData`), refresh the snapshot via `scripts/refresh-snapshots.ts` (wrapped as `pnpm snapshots:refresh`).

```bash
# all fixtures
pnpm snapshots:refresh

# one fixture
pnpm snapshots:refresh -- --connection trade_v11.5

# review and commit
git diff -- snapshots/
git add snapshots/<fixture_id>.xml
git commit -m "snapshots: refresh <fixture_id>"
```

The script reads creds from `.env.local` at repo root (auto-sourced; gitignored) or from current shell. Required per fixture: a single env var `ONEC_<PREFIX>_URL` containing the full URL with userinfo (`http://user:password@host/path`), where `<PREFIX>` is `TRADE_V11_5` or `BP_V3_0`. If credentials contain any reserved (`@`, `:`, `/`, `?`, `#`, `[`, `]`, ` `, `+`) or non-ASCII characters, percent-encode them via `encodeURIComponent` before placing them into the URL. It validates env presence up front, fetches `$metadata` to a temp file, sanity-checks the response is XML (1С on auth issues can return an HTML error page with HTTP 200), and atomically replaces the snapshot only on success — a partial fetch never overrides a known-good file.

The diff in PR will show what changed — useful for tracking schema drift over time.

## Running integration tests locally

Live and write tests run against real 1С bases. Drop credentials into a repo-root `.env.local`:

```text
ONEC_TESTS_ALLOW_WRITES=true
ONEC_TRADE_V11_5_URL=http://user:pass@host/path/odata/standard.odata
ONEC_BP_V3_0_URL=http://user:pass@host/path/odata/standard.odata
HTTP_PROXY=http://proxy.example.com:8080   # only if behind a corporate proxy
HTTPS_PROXY=http://proxy.example.com:8080  # mirror for HTTPS fixture URLs
NODE_USE_ENV_PROXY=1                       # only if HTTP_PROXY/HTTPS_PROXY is set
```

Then `pnpm test` exercises every gate (unit + offline + live + write + e2e). Without `.env.local`, the live and write categories are silently skipped — setting any single `ONEC_<ID>_URL` activates only that fixture; missing URLs skip cleanly.

`.env.local` is git-ignored. Values never leave the developer machine and are not part of the published package.
