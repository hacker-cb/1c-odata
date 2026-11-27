import type { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

/** A readline interface whose question is never answered: the input closes instead. */
const rl = vi.hoisted(() => ({ current: undefined as (EventEmitter & { close(): void }) | undefined }))
vi.mock('node:readline/promises', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  return {
    createInterface: () => {
      const iface = Object.assign(new Emitter(), {
        question: () => new Promise<string>(() => {}),
        close: () => iface.emit('close'),
      })
      rl.current = iface
      return iface
    },
  }
})

describe('promptLine when the input closes before an answer', () => {
  it('throws rather than leaving the question pending', async () => {
    const { promptLine } = await import('../../src/commands/_prompt.js')
    const asked = promptLine('Server timezone: ')
    rl.current?.close()
    await expect(asked).rejects.toThrow('Input closed before an answer')
  })
})
