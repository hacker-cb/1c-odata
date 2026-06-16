import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'

/** Ask for a line of input. Returns `opts.default` when the user enters nothing. */
export async function promptLine(label: string, opts: { default?: string } = {}): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const answer = (await rl.question(label)).trim()
    if (answer === '' && opts.default !== undefined) return opts.default
    return answer
  } finally {
    rl.close()
  }
}

type KeyAction = 'submit' | 'abort' | 'backspace' | 'append'

/** Classify a raw keypress for {@link promptHidden}: Ctrl-D submits a non-empty buffer but aborts an empty one. */
function classifyKey(code: number, buffer: string): KeyAction {
  if (code === 13 || code === 10) return 'submit' // Enter (CR / LF)
  if (code === 4) return buffer === '' ? 'abort' : 'submit' // Ctrl-D (EOT)
  if (code === 3) return 'abort' // Ctrl-C (ETX)
  if (code === 127 || code === 8) return 'backspace' // Backspace / Delete
  return 'append'
}

/**
 * Ask for a secret with no echo (raw-mode TTY, like `sudo` / `gh auth login`).
 * The typed characters never reach the screen, shell history, or `ps`. Requires
 * an interactive terminal — headless callers must use the env var instead.
 */
export async function promptHidden(label: string): Promise<string> {
  if (stdin.isTTY !== true) {
    throw new Error(
      'A password prompt requires an interactive terminal (TTY). Provide the password via the ONEC_<NAME>_PASSWORD env var instead.',
    )
  }
  return new Promise<string>((resolve, reject) => {
    stdout.write(label)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let buffer = ''
    const cleanup = (): void => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener('data', onData)
      stdin.removeListener('end', onEnd)
    }
    const onEnd = (): void => {
      // stdin closed (EOF) without a terminating keystroke — restore the
      // terminal and fail instead of hanging in raw mode forever.
      cleanup()
      stdout.write('\n')
      reject(new Error('Input closed before a password was entered'))
    }
    // Single exit: restore the TTY, then settle. `null` aborts (rejects).
    const finish = (result: string | null): void => {
      cleanup()
      stdout.write('\n')
      if (result === null) reject(new Error('Aborted'))
      else resolve(result)
    }
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        const action = classifyKey(ch.charCodeAt(0), buffer)
        if (action === 'submit') {
          finish(buffer)
          return
        }
        if (action === 'abort') {
          finish(null)
          return
        }
        if (action === 'backspace') buffer = buffer.slice(0, -1)
        else if (action === 'append') buffer += ch
      }
    }
    stdin.on('data', onData)
    stdin.once('end', onEnd)
  })
}

/** Yes/no confirmation. */
export async function promptConfirm(label: string, defaultYes = false): Promise<boolean> {
  const answer = (await promptLine(`${label} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).toLowerCase()
  if (answer === '') return defaultYes
  return answer === 'y' || answer === 'yes'
}
