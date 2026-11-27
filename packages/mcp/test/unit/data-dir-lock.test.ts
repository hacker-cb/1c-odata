import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, saveConfig } from '../../src/config.js'
import { DataDirLockedError, dataDirLockPath, withDataDirLock } from '../../src/data-dir-lock.js'

let dir: string
let lockPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-lock-'))
  lockPath = dataDirLockPath(dir)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Write a lock file as another owner would, its mtime `ageMs` in the past. */
function plantLock(owner: { pid: number; hostname: string } | string, ageMs = 0): void {
  const raw =
    typeof owner === 'string'
      ? owner
      : JSON.stringify({ ...owner, token: 'theirs', since: new Date(Date.now() - ageMs).toISOString() })
  writeFileSync(lockPath, raw)
  const at = new Date(Date.now() - ageMs)
  utimesSync(lockPath, at, at)
}

/** A pid that ran on this host and no longer does. */
function deadPid(): number {
  const pid = spawnSync(process.execPath, ['-e', '']).pid
  if (pid === undefined) throw new Error('no pid')
  return pid
}

const fast = { timeoutMs: 150, staleMs: 60_000, reusedPidMs: 600_000, heartbeatMs: 5_000 }

describe('withDataDirLock', () => {
  it('holds the lock file while the task runs and deletes it after', async () => {
    const seen = await withDataDirLock(dir, async () => JSON.parse(readFileSync(lockPath, 'utf8')))
    expect(seen).toMatchObject({ pid: process.pid, hostname: hostname() })
    expect(existsSync(lockPath)).toBe(false)
  })

  it('creates a data dir that does not exist yet', async () => {
    const nested = join(dir, 'new', 'dir')
    await withDataDirLock(nested, async () => undefined)
    expect(existsSync(nested)).toBe(true)
  })

  it('releases the lock when the task throws', async () => {
    await expect(
      withDataDirLock(dir, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('serializes two holders: the second runs only after the first released', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    const first = withDataDirLock(dir, async () => {
      order.push('first:start')
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      order.push('first:end')
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = withDataDirLock(dir, async () => {
      order.push('second')
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(order).toEqual(['first:start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })

  it('gives up on a lock a running process holds, naming it — and runs nothing', async () => {
    plantLock({ pid: process.ppid, hostname: hostname() })
    let ran = false
    const attempt = withDataDirLock(
      dir,
      async () => {
        ran = true
      },
      { timings: fast },
    )
    await expect(attempt).rejects.toBeInstanceOf(DataDirLockedError)
    await expect(attempt).rejects.toThrow(new RegExp(`process ${process.ppid} on .*delete .*\\.lock`))
    expect(ran).toBe(false)
    expect(existsSync(lockPath)).toBe(true) // never taken from a live owner
  })

  it('takes over at once a lock whose process on this host is gone', async () => {
    plantLock({ pid: deadPid(), hostname: hostname() })
    await expect(withDataDirLock(dir, async () => 'ran', { timings: fast })).resolves.toBe('ran')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('takes over a lock of a running pid on this host once its mtime is past the reused-pid bound', async () => {
    plantLock({ pid: process.ppid, hostname: hostname() }, 2_000)
    await expect(withDataDirLock(dir, async () => 'ran', { timings: { ...fast, reusedPidMs: 1_000 } })).resolves.toBe(
      'ran',
    )
  })

  it('waits on another host’s lock while it is fresh, and takes it over once stale', async () => {
    plantLock({ pid: 1, hostname: 'elsewhere.test' })
    await expect(withDataDirLock(dir, async () => 'ran', { timings: fast })).rejects.toBeInstanceOf(DataDirLockedError)
    plantLock({ pid: 1, hostname: 'elsewhere.test' }, 120_000)
    await expect(withDataDirLock(dir, async () => 'ran', { timings: fast })).resolves.toBe('ran')
  })

  it('waits on an unreadable lock while it is fresh (one being written), and takes it over once stale', async () => {
    plantLock('')
    await expect(withDataDirLock(dir, async () => 'ran', { timings: fast })).rejects.toBeInstanceOf(DataDirLockedError)
    plantLock('{not json', 120_000)
    await expect(withDataDirLock(dir, async () => 'ran', { timings: fast })).resolves.toBe('ran')
  })

  it('takes over a lock this process left under a token it no longer holds', async () => {
    plantLock({ pid: process.pid, hostname: hostname() })
    await expect(withDataDirLock(dir, async () => 'ran', { timings: fast })).resolves.toBe('ran')
  })

  it('an abort stops the wait, and nothing runs', async () => {
    plantLock({ pid: process.ppid, hostname: hostname() })
    const controller = new AbortController()
    let ran = false
    const attempt = withDataDirLock(
      dir,
      async () => {
        ran = true
      },
      { signal: controller.signal, timings: { ...fast, timeoutMs: 5_000 } },
    )
    setTimeout(() => controller.abort(new Error('cancelled')), 30)
    await expect(attempt).rejects.toThrow('cancelled')
    expect(ran).toBe(false)
  })

  it('does not delete on release a lock another process took over meanwhile', async () => {
    await withDataDirLock(dir, async () => {
      plantLock({ pid: process.ppid, hostname: hostname() })
    })
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ token: 'theirs' })
  })

  it('refreshes the lock’s mtime while held', async () => {
    await withDataDirLock(
      dir,
      async () => {
        const past = new Date(Date.now() - 30_000)
        utimesSync(lockPath, past, past)
        await new Promise((resolve) => setTimeout(resolve, 80))
        expect(Date.now() - statSync(lockPath).mtimeMs).toBeLessThan(5_000)
      },
      { timings: { ...fast, heartbeatMs: 20 } },
    )
  })
})

describe('upserts from separate processes (#269)', () => {
  const child = fileURLToPath(new URL('../fixtures/upsert-child.ts', import.meta.url))

  /** Run the child process; resolves once it printed `ready`, with a promise of its exit. */
  function runChild(names: string[]): Promise<{ exited: Promise<{ code: number | null; stderr: string }> }> {
    const proc = spawn(process.execPath, ['--import', 'tsx', child, dir, names.join(',')], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
      proc.on('close', (code) => resolve({ code, stderr }))
    })
    return new Promise((resolve, reject) => {
      proc.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('ready')) resolve({ exited })
      })
      proc.on('error', reject)
      void exited.then(({ code, stderr: err }) => reject(new Error(`child exited ${code} before ready: ${err}`)))
    })
  }

  it('a change in another process waits for this one’s read-modify-write, and neither is lost', async () => {
    saveConfig(dir, { connections: {} })
    let exited!: Promise<{ code: number | null; stderr: string }>
    await withDataDirLock(dir, async () => {
      const config = loadConfig(dir) // read before the other process changes anything
      ;({ exited } = await runChild(['b']))
      // Unlocked, the child would write `b` well within this pause — and the save below would drop it.
      await new Promise((resolve) => setTimeout(resolve, 300))
      config.connections.a = { baseUrl: 'http://a.test/odata/standard.odata', login: 'u', serverTimezone: 'UTC' }
      saveConfig(dir, config)
    })
    const { code, stderr } = await exited
    expect(stderr).toBe('')
    expect(code).toBe(0)
    expect(Object.keys(loadConfig(dir).connections).sort()).toEqual(['a', 'b'])
  }, 30_000)

  it('processes adding different connections at once keep every one', async () => {
    const batches = [0, 1, 2, 3].map((p) => [0, 1, 2, 3, 4].map((i) => `p${p}-c${i}`))
    const children = await Promise.all(batches.map((names) => runChild(names)))
    const results = await Promise.all(children.map((c) => c.exited))
    for (const { code, stderr } of results) {
      expect(stderr).toBe('')
      expect(code).toBe(0)
    }
    expect(Object.keys(loadConfig(dir).connections).sort()).toEqual(batches.flat().sort())
  }, 60_000)
})
