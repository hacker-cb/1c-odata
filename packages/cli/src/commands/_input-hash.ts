import { createHash } from 'node:crypto'
import type { GenerateOptions } from '../codegen/index.js'

/**
 * Deterministic JSON serialization for plain JSON data — keys sorted
 * alphabetically at every nesting level, no whitespace. Required for stable
 * `options` hashes: `JSON.stringify` reflects insertion order in V8, which
 * would let a config rewrite that just swapped two property orders invalidate
 * the cache without changing the effective options.
 *
 * Behavior on plain JSON (primitives, `null`, arrays, plain objects):
 * `undefined` values are skipped, arrays preserve order (they are sequences,
 * not sets), `null` and primitives serialize as in JSON.
 *
 * NOT a drop-in `JSON.stringify` replacement for non-plain values: `Date`
 * (which `JSON.stringify` calls `.toJSON()` on), `Map`, `Set`, class
 * instances, etc. all serialize as plain objects here. The caller (`computeInputs`)
 * only ever passes a `GenerateOptions` object (primitives + arrays of strings
 * + nested plain objects), so this is sufficient — but don't reuse this
 * helper for arbitrary user data without confirming the contract.
 */
export function canonicalJSON(value: unknown): string {
  // `JSON.stringify(undefined)` returns the value `undefined` (not a string),
  // which would violate this function's `: string` return contract and break
  // hashing if `undefined` ever flowed in. Treat as `null` — the only call
  // site (`computeInputs`) passes an always-defined `GenerateOptions` object,
  // so this branch is defensive rather than load-bearing.
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`
  const entries: string[] = []
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[k]
    if (v === undefined) continue
    entries.push(`${JSON.stringify(k)}:${canonicalJSON(v)}`)
  }
  return `{${entries.join(',')}}`
}

/**
 * Inputs that determine codegen output staleness for one connection.
 * Stored verbatim in `__metadata.json` and compared on next run.
 */
export interface InputHash {
  /** SHA-256 of the metadata XML file content. */
  metadata: string
  /** SHA-256 of the canonical-JSON of `connectionToCodegenOptions(conn)`. */
  options: string
  /** `@1c-odata/cli` package.json version verbatim. */
  cliVersion: string
}

function sha256(s: string): string {
  return `sha256:${createHash('sha256').update(s).digest('hex')}`
}

/**
 * Compute the input-hash triple for one connection.
 *
 * `xml` is the metadata file content, `options` is what
 * `connectionToCodegenOptions(conn)` returns (just `shape` + `include` —
 * the only fields codegen actually consumes), `cliVersion` is the cli
 * package version (read from `package.json` at the call site).
 */
export function computeInputs(xml: string, options: GenerateOptions, cliVersion: string): InputHash {
  return {
    metadata: sha256(xml),
    options: sha256(canonicalJSON(options)),
    cliVersion,
  }
}
