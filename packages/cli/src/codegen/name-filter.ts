import micromatch from 'micromatch'

export interface NameFilterOptions {
  include?: string[]
}

/**
 * Build an entity-name filter from a glob include list.
 *
 * Semantics:
 *   - undefined / empty include  → all entities pass
 *   - non-empty include          → name passes iff at least one glob in
 *                                  `include` matches it
 *
 * Glob syntax — micromatch (same as `.gitignore` / npm-style globs).
 */
export function buildNameFilter(opts: NameFilterOptions): (name: string) => boolean {
  const include = opts.include ?? []
  return (name: string) => {
    if (include.length > 0 && !micromatch.isMatch(name, include)) return false
    return true
  }
}
