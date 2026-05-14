// CI-only undici proxy preload. Loaded via `NODE_OPTIONS=--import ...` from
// the `test-example` job so that `1c-odata fetch` (CLI) and `pnpm demo`
// (runtime client) can reach the live 1С base through the corporate proxy.
//
// Production runtime has no per-client proxy support by design — undici is
// configured process-wide. This mirrors the same setGlobalDispatcher trick
// already used by `packages/client/test/setup.ts` for live integration tests.
// The file is loaded only when CI sets NODE_OPTIONS, never by consumers.
import { ProxyAgent, setGlobalDispatcher } from 'undici'

const proxy = process.env.HTTP_PROXY?.trim() || process.env.HTTPS_PROXY?.trim()
if (proxy) {
  setGlobalDispatcher(new ProxyAgent(proxy))
}
