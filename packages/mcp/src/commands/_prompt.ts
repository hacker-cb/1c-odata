import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { InvalidArgumentError } from '@1c-odata/client'

/**
 * Read a password from stdin (for `--password-stdin`): drain stdin, drop a single
 * trailing newline (the line terminator from `echo` / a file — never real
 * whitespace, since passwords are opaque), and reject an empty result.
 */
export async function readPasswordStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stdin) chunks.push(chunk as Buffer)
  const value = Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '')
  if (value === '') {
    throw new InvalidArgumentError('--password-stdin received an empty password', { argument: 'password' })
  }
  return value
}

/**
 * Ask for a line of input, trimmed. Throws where the input closes before an
 * answer (Ctrl-D on an empty line, stdin run dry), rather than leaving the
 * question pending.
 */
export async function promptLine(label: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout })
  let answered = false
  const closed = new Promise<never>((_, reject) => {
    rl.once('close', () => {
      if (!answered) reject(new InvalidArgumentError('Input closed before an answer', { argument: 'stdin' }))
    })
  })
  try {
    const answer = await Promise.race([rl.question(label), closed])
    answered = true
    return answer.trim()
  } finally {
    answered = true
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
