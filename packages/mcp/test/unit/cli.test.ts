import { describe, expect, it } from 'vitest'
import { buildProgram } from '../../src/cli.js'

/** Parse `args` capturing all commander output; exitOverride turns exit into a throw. */
async function captureParse(args: string[]): Promise<{ out: string; code: string | undefined }> {
  const program = buildProgram()
  program.exitOverride()
  let out = ''
  program.configureOutput({ writeOut: (s) => (out += s), writeErr: (s) => (out += s) })
  try {
    await program.parseAsync(['node', '1c-odata-mcp', ...args])
    return { out, code: undefined }
  } catch (err) {
    return { out, code: (err as { code?: string }).code }
  }
}

describe('buildProgram', () => {
  it('registers serve plus the management commands', () => {
    const names = buildProgram()
      .commands.map((c) => c.name())
      .sort()
    expect(names).toEqual(['add', 'label', 'list', 'remove', 'serve', 'set-credentials', 'test'])
  })

  it('prints help (not serve) when invoked with no subcommand', async () => {
    // serve is not the default command: a bare invocation prints help and exits,
    // instead of starting the stdio server and hanging on JSON-RPC. (serve would
    // import the MCP SDK and block, so reaching it here would hang the test.)
    // The full command list — incl. serve — is shown, and the generated
    // `help [command]` subcommand stays available (no root .action() suppresses it).
    const { out, code } = await captureParse([])
    expect(code).toBe('commander.help')
    expect(out).toContain('Commands:')
    expect(out).toContain('serve')
    expect(out).toContain('set-credentials')
  })
})
