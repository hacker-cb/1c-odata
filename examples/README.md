# Examples

Working example projects in this workspace. Each example is a separate pnpm package with its own README.

| Directory | Status | Demonstrates |
|---|---|---|
| [`basic/`](./basic) | landed | Read-only operations, query builder, pagination |

More examples may follow if user demand surfaces — open an issue with your use case.

## Running an example

```bash
pnpm --filter <example-name> demo
```

Each example reads connection credentials from a single env var per connection in the form `ONEC_<NAME>_URL=http://user:password@host/path`. If username or password contains any reserved (`@`, `:`, `/`, `?`, `#`, `[`, `]`, ` `, `+`) or non-ASCII characters, percent-encode them via `encodeURIComponent` before placing them into the URL — `parseConnectionUrl` decodes the original values back via WHATWG URL parsing. See the example's README for the specific variable names.
