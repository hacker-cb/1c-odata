import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { mapWithConcurrency } from './concurrency.js'

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
  await mapWithConcurrency(Array.from(files), WRITE_CONCURRENCY, ([relPath, content]) =>
    writeOneFile(join(rootDir, relPath), content),
  )
}
