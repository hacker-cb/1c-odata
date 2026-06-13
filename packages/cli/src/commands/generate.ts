import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { type GenerateOptions, generate } from '../codegen/index.js'
import type { CodegenConfig, CodegenTarget } from '../config.js'
import { writeFiles } from '../writer.js'
import { computeInputs, type InputHash } from './_input-hash.js'
import { pickTargets } from './_shared.js'

export interface RunGenerateOptions {
  cwd: string
  config: CodegenConfig
  target?: string
  /**
   * `@1c-odata/cli` package version. Embedded in `__metadata.json` as part
   * of the input-hash triple used by smart-skip — a version bump invalidates
   * the cache. The CLI bin reads this from `package.json` and threads it
   * through; programmatic callers must supply it.
   */
  cliVersion: string
  /** Bypass the input-hash cache check; regenerate every selected target. */
  force?: boolean
  /**
   * Emit only `__metadata.json` (no TypeScript files). Part of the
   * options-hash, so switching modes invalidates the smart-skip cache.
   */
  metadataOnly?: boolean
}

/**
 * Returns true if `__metadata.json` exists, is valid JSON, has an `inputs`
 * field, and that field deep-equals `current`. Any failure mode (missing
 * file, malformed JSON, missing field, mismatch) returns false — codegen
 * will then run and overwrite.
 */
async function isCacheFresh(metaPath: string, current: InputHash): Promise<boolean> {
  try {
    const raw = await readFile(metaPath, 'utf8')
    const parsed = JSON.parse(raw) as { inputs?: Partial<InputHash> }
    const prior = parsed.inputs
    if (prior === undefined) return false
    return (
      prior.metadata === current.metadata &&
      prior.options === current.options &&
      prior.cliVersion === current.cliVersion
    )
  } catch {
    return false
  }
}

function reportSkip(name: string, includeHint: boolean): void {
  const hint = includeHint ? ' (use --force to regenerate)' : ''
  process.stderr.write(`[${name}] up-to-date${hint}\n`)
}

/**
 * Emit the closure-expansion summary to stderr — matched seed size, total
 * entities/complex types after closure, and the first 10 added type names
 * with their reasons. No-op when codegen reported no closure additions.
 */
function reportClosure(name: string, meta: string | undefined): void {
  const parsed = JSON.parse(meta ?? '{}') as {
    closure?: {
      seedSize: number
      totalEntities: number
      totalComplexTypes: number
      additions: { kind: string; name: string; reason: string }[]
    }
  }
  if (!parsed.closure || parsed.closure.additions.length === 0) return
  const c = parsed.closure
  process.stderr.write(
    `[${name}] include matched ${c.seedSize} directly; closure expanded to ${c.totalEntities} entities + ${c.totalComplexTypes} complex types\n`,
  )
  const head = c.additions.slice(0, 10)
  for (const a of head) {
    process.stderr.write(`  + ${a.name}  ← ${a.reason}\n`)
  }
  if (c.additions.length > 10) {
    process.stderr.write(`  ... (${c.additions.length - 10} more, see __metadata.json:closure)\n`)
  }
}

/** Run `1c-odata generate` — read metadata XML for one or all targets, call codegen, write the resulting files under `<generatedDir>/<target>/`. */
export async function runGenerate(opts: RunGenerateOptions): Promise<void> {
  const metadataDir = resolve(opts.cwd, opts.config.metadataDir ?? './metadata')
  const generatedDir = resolve(opts.cwd, opts.config.generatedDir ?? './generated')
  const targets = pickTargets(opts.config.targets, opts.target)
  let skipHintShown = false

  for (const [name, target] of targets) {
    try {
      const xmlPath = join(metadataDir, `${name}.xml`)
      let xml: string
      try {
        xml = await readFile(xmlPath, 'utf8')
      } catch (e) {
        const err = e as NodeJS.ErrnoException
        if (err.code === 'ENOENT') {
          throw new Error(`Metadata file not found: ${xmlPath}\n  Run "1c-odata fetch --target ${name}" first.`)
        }
        throw e
      }
      const codegenOptions: GenerateOptions = {
        ...targetToCodegenOptions(target),
        ...(opts.metadataOnly === true ? { metadataOnly: true } : {}),
      }
      const inputs = computeInputs(xml, codegenOptions, opts.cliVersion)

      const metaPath = join(generatedDir, name, '__metadata.json')
      if (opts.force !== true && (await isCacheFresh(metaPath, inputs))) {
        reportSkip(name, !skipHintShown)
        skipHintShown = true
        continue
      }

      const result = generate({
        metadata: xml,
        ...codegenOptions,
        inputs,
      })
      reportClosure(name, result.files.get('__metadata.json'))
      await writeFiles(join(generatedDir, name), result.files)
    } catch (e) {
      // Re-throw without wrapping if the message already mentions this target
      // by name — avoids redundantly nested phrasing.
      if (e instanceof Error && e.message.includes(`"${name}"`)) throw e
      if (e instanceof Error && e.message.includes(`--target ${name}`)) throw e
      const message = e instanceof Error ? e.message : String(e)
      throw new Error(`generate failed for target "${name}": ${message}`, { cause: e })
    }
  }
}

function targetToCodegenOptions(target: CodegenTarget): GenerateOptions {
  return {
    ...(target.connection.shape !== undefined ? target.connection.shape : {}),
    ...(target.include !== undefined ? { include: target.include } : {}),
  }
}
