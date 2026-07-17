import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * This package's version, read from its `package.json` relative to the running
 * module: the compiled bundle lives at `dist/*.js` (package.json one level up),
 * the source at `src/*.ts` (two levels up). A missing/unreadable file must never
 * crash startup, so it falls back to `0.0.0`.
 */
export function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [join(here, '..', 'package.json'), join(here, '..', '..', 'package.json')]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string }
      if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version
    } catch {
      // Not found at this depth — try the next candidate.
    }
  }
  return '0.0.0'
}
