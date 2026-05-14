import type { Connection } from '@1c-odata/client'

/**
 * Filter the connections map to a single connection (when `filter` is set)
 * or return all entries. Throws when `filter` targets an unknown connection.
 */
export function pickConnections(
  connections: Record<string, Connection>,
  filter: string | undefined,
): [string, Connection][] {
  const all = Object.entries(connections)
  if (filter === undefined) return all
  const found = all.find(([name]) => name === filter)
  if (!found) {
    throw new Error(`connection "${filter}" not found in config`)
  }
  return [found]
}
