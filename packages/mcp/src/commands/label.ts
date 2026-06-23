import { setConnectionLabel } from '../connections.js'

export interface LabelOptions {
  dataDir: string
  name: string
  /** New label; a blank value clears the stored label (reverts to the name). */
  label: string
}

/**
 * Set or clear a connection's display label (never touches credentials).
 * {@link setConnectionLabel} authoritatively rejects an unknown connection.
 */
export async function runLabel(opts: LabelOptions): Promise<void> {
  const result = await setConnectionLabel({ dataDir: opts.dataDir, name: opts.name, label: opts.label })
  if (result.cleared) {
    process.stdout.write(`✓ Label cleared for "${opts.name}" — it now shows its name.\n`)
  } else {
    process.stdout.write(`✓ Label for "${opts.name}" set to "${result.label}".\n`)
  }
}
