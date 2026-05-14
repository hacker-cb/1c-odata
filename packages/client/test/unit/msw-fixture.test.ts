import { describe, expect, it } from 'vitest'
import { createMswServer } from '../fixtures/msw-server.js'

describe('msw fixture loads', () => {
  it('createMswServer returns a server with start/close', () => {
    const server = createMswServer()
    expect(server).toHaveProperty('listen')
    expect(server).toHaveProperty('close')
  })
})
