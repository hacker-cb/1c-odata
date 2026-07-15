/** Default `$metadata` download timeout (ms). 1С EDMX is 10+ MB on real bases. */
export const DEFAULT_METADATA_TIMEOUT_MS = 120_000

/** Default light reachability-probe timeout (ms). The service root is small, so this is short. */
export const DEFAULT_REACHABILITY_TIMEOUT_MS = 15_000
