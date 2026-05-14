import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { ParseError } from './errors.js'
import type { MetadataIndex } from './validate.js'

/**
 * Load and runtime-validate a codegen-emitted `__metadata.json` file.
 *
 * Validates structural shape: `schemaNamespace`, `schemas`, `entitySetToType`,
 * optional `shape`, optional `enums`. Mismatches throw `ParseError` with a
 * JSON-path breadcrumb pointing at the offending node (e.g.
 * `$.schemas.Catalog_X.properties.Y.type`).
 *
 * @public
 */
export async function loadMetadataIndex(input: string | URL): Promise<MetadataIndex> {
  let path: string
  if (typeof input === 'string') {
    path = input
  } else {
    try {
      path = fileURLToPath(input)
    } catch (e) {
      throw new ParseError(`Invalid URL input (expected file: scheme): ${input.toString()}`, { cause: e })
    }
  }
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (e) {
    throw new ParseError(`Failed to read ${path}`, { cause: e })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new ParseError(`Invalid JSON in ${path}`, { cause: e })
  }
  assertMetadataIndex(parsed, path, '$')
  return parsed
}

// ── type guards ──────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function fail(filePath: string, subpath: string, expected: string, got: unknown): never {
  const gotDesc = got === null ? 'null' : Array.isArray(got) ? 'array' : typeof got
  throw new ParseError(`Invalid metadata at ${filePath} ${subpath}: expected ${expected}, got ${gotDesc}`)
}

function assertString(v: unknown, filePath: string, path: string): asserts v is string {
  if (typeof v !== 'string') fail(filePath, path, 'string', v)
}

function assertBoolean(v: unknown, filePath: string, path: string): asserts v is boolean {
  if (typeof v !== 'boolean') fail(filePath, path, 'boolean', v)
}

function assertPlainObject(v: unknown, filePath: string, path: string): asserts v is Record<string, unknown> {
  if (!isPlainObject(v)) fail(filePath, path, 'object', v)
}

function assertPropertySchema(v: unknown, filePath: string, path: string): void {
  assertPlainObject(v, filePath, path)
  assertString(v.type, filePath, `${path}.type`)
  assertBoolean(v.nullable, filePath, `${path}.nullable`)
  if (v.maxLength !== undefined && typeof v.maxLength !== 'number')
    fail(filePath, `${path}.maxLength`, 'number', v.maxLength)
}

function assertEntitySchema(v: unknown, filePath: string, path: string): void {
  assertPlainObject(v, filePath, path)
  assertPlainObject(v.properties, filePath, `${path}.properties`)
  for (const [name, prop] of Object.entries(v.properties)) {
    assertPropertySchema(prop, filePath, `${path}.properties.${name}`)
  }
  if (v.valueStorages !== undefined) {
    if (!Array.isArray(v.valueStorages)) fail(filePath, `${path}.valueStorages`, 'array', v.valueStorages)
    for (const [i, x] of v.valueStorages.entries()) assertString(x, filePath, `${path}.valueStorages[${i}]`)
  }
}

function assertDataShape(v: unknown, filePath: string, path: string): void {
  assertPlainObject(v, filePath, path)
  const i64 = v.int64Mode
  if (i64 !== undefined && i64 !== 'number' && i64 !== 'bigint' && i64 !== 'string') {
    fail(filePath, `${path}.int64Mode`, "'number' | 'bigint' | 'string'", i64)
  }
  const dm = v.dateMode
  if (dm !== undefined && dm !== 'date' && dm !== 'string') {
    fail(filePath, `${path}.dateMode`, "'date' | 'string'", dm)
  }
}

function assertEnumCatalog(v: unknown, filePath: string, path: string): void {
  assertPlainObject(v, filePath, path)
  for (const [name, def] of Object.entries(v)) {
    assertPlainObject(def, filePath, `${path}.${name}`)
    assertString(def.underlyingType, filePath, `${path}.${name}.underlyingType`)
    if (!Array.isArray(def.members)) fail(filePath, `${path}.${name}.members`, 'array', def.members)
    for (const [i, m] of def.members.entries()) {
      assertPlainObject(m, filePath, `${path}.${name}.members[${i}]`)
      assertString(m.name, filePath, `${path}.${name}.members[${i}].name`)
      if (m.value !== undefined && typeof m.value !== 'number') {
        fail(filePath, `${path}.${name}.members[${i}].value`, 'number', m.value)
      }
    }
  }
}

function assertMetadataIndex(v: unknown, filePath: string, path: string): asserts v is MetadataIndex {
  assertPlainObject(v, filePath, path)
  assertString(v.schemaNamespace, filePath, `${path}.schemaNamespace`)
  if (v.schemaNamespace === '') fail(filePath, `${path}.schemaNamespace`, 'non-empty string', v.schemaNamespace)
  assertPlainObject(v.schemas, filePath, `${path}.schemas`)
  for (const [name, schema] of Object.entries(v.schemas)) {
    assertEntitySchema(schema, filePath, `${path}.schemas.${name}`)
  }
  assertPlainObject(v.entitySetToType, filePath, `${path}.entitySetToType`)
  for (const [name, type] of Object.entries(v.entitySetToType)) {
    assertString(type, filePath, `${path}.entitySetToType.${name}`)
  }
  if (v.shape !== undefined) assertDataShape(v.shape, filePath, `${path}.shape`)
  if (v.enums !== undefined) assertEnumCatalog(v.enums, filePath, `${path}.enums`)
}
