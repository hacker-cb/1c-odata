import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Write a single file, creating any missing parent directories. UTF-8 text mode.
 */
export async function writeOneFile(absolutePath: string, content: string): Promise<void> {
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, content, 'utf8')
}

/**
 * Write every (path → content) entry under `rootDir` with bounded concurrency.
 * Paths are joined with `node:path.join` so POSIX-style entries from codegen
 * work cross-platform. With 2000+ files (e.g. trade_v11.5) unbounded
 * `Promise.all` can hit OS file-handle limits (EMFILE) on Windows / CI.
 */
const WRITE_CONCURRENCY = 64

export async function writeFiles(rootDir: string, files: Map<string, string>): Promise<void> {
  const entries = Array.from(files)
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < entries.length) {
      const i = cursor++
      const entry = entries[i]
      if (entry === undefined) return
      const [relPath, content] = entry
      await writeOneFile(join(rootDir, relPath), content)
    }
  }
  const workers = Array.from({ length: Math.min(WRITE_CONCURRENCY, entries.length) }, worker)
  await Promise.all(workers)
}
