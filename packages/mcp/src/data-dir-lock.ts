import { randomBytes } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

/**
 * Cross-process lock over a data directory (#269): every process sharing it —
 * MCP servers of different clients, the CLI — takes it around a whole
 * read-modify-write of `config.json` and the secrets that go with it.
 *
 * The lock is the file `<dataDir>/.lock`, created exclusively (`wx`) and holding
 * its owner — `{ pid, hostname, token, since }`. The owner refreshes its mtime
 * every {@link DataDirLockTimings.heartbeatMs} while it holds it, and deletes it
 * on release — only while the token in it is still its own. A lock is stale, and
 * taken over, where its owner is gone: on this host, a pid that no longer runs
 * (or an mtime older than {@link DataDirLockTimings.reusedPidMs}, a pid since
 * reused); elsewhere or unreadable, an mtime older than
 * {@link DataDirLockTimings.staleMs}. A takeover renames the stale file aside
 * and checks it moved the one it judged — so two waiters never both take one
 * lock, and a fresh lock moved by mistake is put back.
 */

/** How long a lock is waited for, and when it counts as abandoned. Overridable for tests only. */
export interface DataDirLockTimings {
  /** Give up waiting after this long. */
  timeoutMs: number
  /** A lock whose owner cannot be checked (another host, unreadable) is stale once its mtime is this old. */
  staleMs: number
  /** A lock whose owner pid still runs on this host is stale once its mtime is this old — the pid was reused. */
  reusedPidMs: number
  /** The owner refreshes the lock's mtime this often. */
  heartbeatMs: number
}

export const DEFAULT_DATA_DIR_LOCK_TIMINGS: DataDirLockTimings = {
  timeoutMs: 10_000,
  staleMs: 60_000,
  reusedPidMs: 10 * 60_000,
  heartbeatMs: 5_000,
}

/** The poll interval while waiting: starts here, doubles, and stops growing at {@link MAX_POLL_MS}. */
const FIRST_POLL_MS = 10
const MAX_POLL_MS = 250

const LOCK_FILE = '.lock'

/** Tokens of the locks this process holds right now: a lock naming this pid with any other token is abandoned. */
const heldHere = new Set<string>()

/** The owner a lock file names. */
interface LockOwner {
  pid: number
  hostname: string
  token: string
  since: string
}

/** Thrown where the data directory stays locked by another process past the wait. */
export class DataDirLockedError extends Error {
  readonly lockPath: string
  constructor(lockPath: string, owner: LockOwner | undefined) {
    const who =
      owner !== undefined ? `process ${owner.pid} on ${owner.hostname} since ${owner.since}` : 'another process'
    super(
      `The 1c-odata data directory is locked by ${who} — another 1c-odata-mcp is changing connections. Retry; if no such process runs, delete ${lockPath}.`,
    )
    this.name = 'DataDirLockedError'
    this.lockPath = lockPath
  }
}

/** The lock file of `dataDir`. */
export function dataDirLockPath(dataDir: string): string {
  return join(dataDir, LOCK_FILE)
}

/**
 * Run `task` holding the data-dir lock of `dataDir`, waiting for it up to
 * `timeoutMs`; `signal` aborts the wait (nothing has run then). The lock is
 * released however `task` ends.
 */
export async function withDataDirLock<T>(
  dataDir: string,
  task: () => Promise<T>,
  opts: { signal?: AbortSignal | undefined; timings?: Partial<DataDirLockTimings> } = {},
): Promise<T> {
  const timings = { ...DEFAULT_DATA_DIR_LOCK_TIMINGS, ...opts.timings }
  const lockPath = dataDirLockPath(dataDir)
  const token = await acquire(dataDir, lockPath, timings, opts.signal)
  heldHere.add(token)
  const heartbeat = setInterval(() => touch(lockPath), timings.heartbeatMs)
  heartbeat.unref()
  try {
    return await task()
  } finally {
    clearInterval(heartbeat)
    heldHere.delete(token)
    release(lockPath, token)
  }
}

async function acquire(
  dataDir: string,
  lockPath: string,
  timings: DataDirLockTimings,
  signal: AbortSignal | undefined,
): Promise<string> {
  mkdirSync(dataDir, { recursive: true })
  const token = randomBytes(16).toString('hex')
  const content = JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    token,
    since: new Date().toISOString(),
  } satisfies LockOwner)
  const deadline = Date.now() + timings.timeoutMs
  let poll = FIRST_POLL_MS
  for (;;) {
    signal?.throwIfAborted()
    if (tryCreate(lockPath, content)) return token
    const held = readLock(lockPath)
    if (held === undefined) continue // released meanwhile: try again at once
    if (isStale(held, timings) && takeOver(lockPath, held.raw)) continue
    const left = deadline - Date.now()
    if (left <= 0) throw new DataDirLockedError(lockPath, held.owner)
    await sleep(Math.min(poll, left), signal)
    poll = Math.min(poll * 2, MAX_POLL_MS)
  }
}

/** Create the lock file holding `content`; `false` where one already exists. */
function tryCreate(lockPath: string, content: string): boolean {
  try {
    writeFileSync(lockPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

/** A lock file as read: its raw text, its owner where it parses, and its mtime. */
interface HeldLock {
  raw: string
  owner: LockOwner | undefined
  mtimeMs: number
}

/** The lock at `lockPath`, or `undefined` where there is none (anymore). */
function readLock(lockPath: string): HeldLock | undefined {
  let mtimeMs: number
  let raw: string
  try {
    mtimeMs = statSync(lockPath).mtimeMs
    raw = readFileSync(lockPath, 'utf8')
  } catch (err) {
    if (isGone(err)) return undefined
    // Open elsewhere for a moment (Windows): held, owner unknown — waited on, never judged stale.
    if (isBusy(err)) return { raw: '', owner: undefined, mtimeMs: Date.now() }
    throw err
  }
  return { raw, owner: parseOwner(raw), mtimeMs }
}

/** The owner `raw` names, or `undefined` where it is not one (a lock still being written, a damaged file). */
function parseOwner(raw: string): LockOwner | undefined {
  try {
    const data = JSON.parse(raw) as Partial<LockOwner> | null
    if (
      data !== null &&
      typeof data === 'object' &&
      typeof data.pid === 'number' &&
      typeof data.hostname === 'string' &&
      typeof data.token === 'string' &&
      typeof data.since === 'string'
    ) {
      return { pid: data.pid, hostname: data.hostname, token: data.token, since: data.since }
    }
  } catch {
    // not JSON (yet)
  }
  return undefined
}

function isStale(held: HeldLock, timings: DataDirLockTimings): boolean {
  const age = Date.now() - held.mtimeMs
  const { owner } = held
  if (owner !== undefined && owner.hostname === hostname()) {
    // This process's own, under a token it no longer holds: a release that could not delete it.
    if (owner.pid === process.pid) return !heldHere.has(owner.token)
    return !isRunning(owner.pid) || age > timings.reusedPidMs
  }
  return age > timings.staleMs
}

/** Whether process `pid` runs on this host — signal 0 tests it, on Windows too. */
function isRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it runs, under another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Take over the stale lock whose text is `staleRaw`: move it aside, and keep it
 * removed only where it is the one judged stale. Another waiter may have taken
 * it over first and created its own lock in between; that one is put back
 * (a hard link never replaces a lock created since). `true` where the slot may
 * now be free — the caller tries to create its lock again.
 */
function takeOver(lockPath: string, staleRaw: string): boolean {
  const aside = `${lockPath}.${process.pid}.${randomBytes(6).toString('hex')}.stale`
  try {
    renameSync(lockPath, aside)
  } catch (err) {
    if (isGone(err)) return true
    if (isBusy(err)) return false
    throw err
  }
  let moved: string | undefined
  try {
    moved = readFileSync(aside, 'utf8')
  } catch {
    moved = undefined
  }
  if (moved !== staleRaw) {
    try {
      linkSync(aside, lockPath)
    } catch {
      // A newer lock stands there already — the moved one's owner finds it lost on release.
    }
  }
  bestEffortUnlink(aside)
  return moved === staleRaw
}

/** Delete the lock where it is still this holder's; never throws — it runs in a `finally`. */
function release(lockPath: string, token: string): void {
  try {
    // Taken over meanwhile (this process stalled past staleness): the lock is another's now.
    if (readLock(lockPath)?.owner?.token !== token) return
  } catch {
    return // unreadable: left for staleness to clear
  }
  // A Windows sharing violation passes in moments; retried briefly so waiters need not judge it stale.
  for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt++) {
    try {
      unlinkSync(lockPath)
      return
    } catch (err) {
      if (isGone(err) || !isBusy(err)) return
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RELEASE_RETRY_MS)
    }
  }
}

const RELEASE_ATTEMPTS = 5
const RELEASE_RETRY_MS = 20

function touch(lockPath: string): void {
  try {
    const now = new Date()
    utimesSync(lockPath, now, now)
  } catch {
    // Gone or unreachable: release reads what stands there.
  }
}

function bestEffortUnlink(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // already gone, or busy for a moment on Windows — a stale lock is taken over by the next waiter
  }
}

function isGone(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT'
}

/** A Windows sharing violation: the file is open in another process for a moment. */
function isBusy(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    function onAbort(): void {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
