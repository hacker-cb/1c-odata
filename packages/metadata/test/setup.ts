import { ProxyAgent, setGlobalDispatcher } from 'undici'

// Test-only: when running live/write integration tests against real 1С
// fixtures, route every request through the corporate proxy. Production
// has no per-client proxy support; this hook is test-only and not part
// of the published bundle.
//
// Gated on any `ONEC_*_URL` env var to keep unit-test runs hermetic —
// `HTTP_PROXY` alone, which can be set in arbitrary shells/CI, must not
// mutate the global undici dispatcher when no integration fixture is
// configured. Pattern-matches the env so adding a fixture to the
// registry in `test/integration/helpers.ts` doesn't require updating
// this list.
const isIntegrationRun = Object.keys(process.env).some(
  (k) => k.startsWith('ONEC_') && k.endsWith('_URL') && process.env[k]?.trim(),
)
const proxy = isIntegrationRun
  ? process.env.HTTP_PROXY?.trim() || process.env.HTTPS_PROXY?.trim() || undefined
  : undefined
if (proxy) {
  setGlobalDispatcher(new ProxyAgent(proxy))
}
