import { describe, expect, it } from 'vitest'
import { buildProgram } from '../../src/cli.js'

describe('buildProgram', () => {
  it('declares two commands: fetch, generate', () => {
    const program = buildProgram()
    const names = program.commands.map((c) => c.name())
    expect(names).toEqual(['fetch', 'generate'])
  })

  it('fetch/generate each have --connection and --config options', () => {
    const program = buildProgram()
    for (const cmd of program.commands) {
      const optNames = cmd.options.map((o) => o.long)
      expect(optNames).toContain('--connection')
      expect(optNames).toContain('--config')
    }
  })

  it('program version + name set', () => {
    const program = buildProgram()
    expect(program.name()).toBe('1c-odata')
    expect(program.version()).toMatch(/\d+\.\d+\.\d+/)
  })

  it('generate accepts --force flag', () => {
    const program = buildProgram()
    const generateCmd = program.commands.find((c) => c.name() === 'generate')
    expect(generateCmd).toBeDefined()
    const optNames = generateCmd?.options.map((o) => o.long)
    expect(optNames).toContain('--force')
  })
})
