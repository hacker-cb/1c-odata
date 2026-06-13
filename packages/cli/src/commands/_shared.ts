import type { CodegenTarget } from '../config.js'

/**
 * Filter the targets map to a single target (when `filter` is set) or return
 * all entries. Throws when `filter` names an unknown target.
 */
export function pickTargets(
  targets: Record<string, CodegenTarget>,
  filter: string | undefined,
): [string, CodegenTarget][] {
  const all = Object.entries(targets)
  if (filter === undefined) return all
  const found = all.find(([name]) => name === filter)
  if (!found) {
    throw new Error(`target "${filter}" not found in config`)
  }
  return [found]
}
