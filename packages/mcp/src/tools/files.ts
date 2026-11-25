import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { UntypedEntity } from '@1c-odata/client'
import { raw } from '@1c-odata/client/filter'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ReadPool } from '../connection-pool.js'
import { toolResult } from './_result.js'

const GUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const NAME_SHAPE = /^[\p{L}\p{N}_]+$/u

/** BSP objects that hold an attached file's bytes (БСП «Работа с файлами», 3.1.x layout). */
const FILE_STORE_REGISTER = 'InformationRegister_ХранилищеФайлов'
const BINARY_STORE = 'Catalog_ХранилищеДвоичныхДанных'
const BINARY_PROP = 'ДвоичныеДанные'
const LEGACY_PROP = 'ФайлХранилище'
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000'

/**
 * Directory downloads are written to: `ONEC_MCP_DOWNLOAD_DIR` (absolute) or `<dataDir>/downloads`.
 * Every file the tools write lands inside it; nothing else on disk is touched.
 */
export function resolveDownloadDir(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.ONEC_MCP_DOWNLOAD_DIR?.trim()
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!isAbsolute(fromEnv)) throw new Error('ONEC_MCP_DOWNLOAD_DIR must be an absolute path')
    return resolve(fromEnv)
  }
  return join(dataDir, 'downloads')
}

/** A file name safe on macOS / Windows / Linux: no separators, no control or reserved characters, bounded length. */
export function safeFileName(name: string, fallback = 'file'): string {
  const printable = Array.from(name)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0
      return code > 0x1f && code !== 0x7f
    })
    .join('')
  const cleaned = printable
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 150)
  return cleaned === '' ? fallback : cleaned
}

interface SavedFile {
  path: string
  bytes: number
  sha256: string
  sha256Base64: string
  contentType: string | null
}

/** Stream `<entitySet>(<key>)/<prop>/$value` into `<dir>/<fileName>` (temp file + rename), hashing as it goes. */
async function saveStream(
  pool: ReadPool,
  connection: string,
  entitySet: string,
  key: string,
  prop: string,
  dir: string,
  fileName: string,
): Promise<SavedFile> {
  const target = resolve(dir, fileName)
  if (!target.startsWith(resolve(dir) + sep)) throw new Error('Refusing to write outside the download directory')
  await mkdir(dir, { recursive: true })
  const { client } = await pool.get(connection)
  const { body, contentType } = await client.entity<UntypedEntity>(entitySet, key).readStream(prop)
  const hash = createHash('sha256')
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.part`
  const out = createWriteStream(tmp, { flags: 'wx', mode: 0o600 })
  let bytes = 0
  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk)
      bytes += chunk.byteLength
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()))
    }
    await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())))
    await rename(tmp, target)
  } catch (err) {
    out.destroy()
    await unlink(tmp).catch(() => undefined)
    throw err
  }
  const digest = hash.digest()
  return { path: target, bytes, sha256: digest.toString('hex'), sha256Base64: digest.toString('base64'), contentType }
}

interface FileCard {
  description: string
  extension: string
  size: number | undefined
  ownerKey: unknown
}

/** Read an attached-file card; refuse files kept in disk volumes, which OData cannot reach. */
async function readFileCard(pool: ReadPool, connection: string, entitySet: string, key: string): Promise<FileCard> {
  const { client } = await pool.get(connection)
  const card = await client.entity<UntypedEntity>(entitySet, key).get()
  const description = String(card.Description ?? '')
  if (card.ТипХраненияФайла === 'ВТомахНаДиске')
    throw new Error(
      `File "${description}" is stored in a disk volume (ТипХраненияФайла = ВТомахНаДиске), not in the infobase; OData cannot read it.`,
    )
  return {
    description,
    extension: String(card.Расширение ?? '').replace(/^\./, ''),
    size: typeof card.Размер === 'number' ? card.Размер : undefined,
    ownerKey: card.ВладелецФайла_Key,
  }
}

/** `<description>.<extension>`, without doubling an extension the description already ends with. */
function cardFileName(card: FileCard): string {
  const base = safeFileName(card.description, 'file')
  const ext = card.extension
  return ext !== '' && !base.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? `${base}.${ext}` : base
}

/** Follow card → ХранилищеФайлов → ХранилищеДвоичныхДанных; fall back to the card's own ФайлХранилище. */
async function downloadCardContent(
  pool: ReadPool,
  connection: string,
  entitySet: string,
  key: string,
  dir: string,
  fileName: string,
): Promise<{ saved: SavedFile; source: string; storedHash: string | undefined }> {
  const { client } = await pool.get(connection)
  const link = await client
    .query<UntypedEntity>(FILE_STORE_REGISTER)
    .filter(() => raw(`cast(Файл, '${entitySet}') eq guid'${key}'`))
    .top(1)
    .get()
  const storeKey = link.value[0]?.ХранилищеДвоичныхДанных_Key
  if (typeof storeKey !== 'string' || storeKey === EMPTY_GUID) {
    const saved = await saveStream(pool, connection, entitySet, key, LEGACY_PROP, dir, fileName)
    return { saved, source: `${entitySet}(${key}).${LEGACY_PROP}`, storedHash: undefined }
  }
  const store = await client.entity<UntypedEntity>(BINARY_STORE, storeKey).get()
  const saved = await saveStream(pool, connection, BINARY_STORE, storeKey, BINARY_PROP, dir, fileName)
  return {
    saved,
    source: `${BINARY_STORE}(${storeKey}).${BINARY_PROP}`,
    storedHash: typeof store.Хеш === 'string' ? store.Хеш : undefined,
  }
}

/** A summary warning when the size or hash check failed, or ''. */
function checkWarning(sizeMatches: boolean | null, hashMatches: boolean | null, expected: number | undefined): string {
  if (sizeMatches !== false && hashMatches !== false) return ''
  const size = sizeMatches === false ? `differs (expected ${expected})` : 'ok'
  const hash = hashMatches === false ? 'differs' : 'ok'
  return ` ⚠ Check failed: size ${size}, hash ${hash}.`
}

/** Register the read-only file download tools. They write only into the download directory. */
export function registerFileTools(server: McpServer, pool: ReadPool, opts: { dataDir: string }): void {
  server.registerTool(
    'download_value_storage',
    {
      title: 'Download a value-storage field',
      description:
        'Save the binary content of one ValueStorage (ХранилищеЗначения) property of one record to a file in the download directory, via GET <entitySet>(<key>)/<property>/$value. Returns the file path, size and SHA-256 — never the bytes. Read-only towards 1С. For a file attached to a document (Catalog_*ПрисоединенныеФайлы) prefer download_attached_file.',
      inputSchema: {
        connection: z.string().describe('Connection name'),
        entitySet: z.string().describe('Entity set, e.g. Catalog_ХранилищеДвоичныхДанных'),
        key: z.string().regex(GUID_SHAPE, 'key must be a Ref_Key GUID').describe('Ref_Key GUID of the record'),
        property: z
          .string()
          .regex(NAME_SHAPE, 'property must be a plain property name')
          .describe('ValueStorage property name, e.g. ДвоичныеДанные (without _Base64Data)'),
        fileName: z.string().optional().describe('File name to save as (sanitized); default <entitySet>_<key>.bin'),
      },
    },
    async ({ connection, entitySet, key, property, fileName }) =>
      toolResult(async () => {
        const dir = join(resolveDownloadDir(opts.dataDir), safeFileName(connection))
        const name = safeFileName(fileName ?? `${entitySet}_${key}.bin`)
        const saved = await saveStream(pool, connection, entitySet, key, property, dir, name)
        return {
          summary: `Saved ${saved.bytes} bytes to ${saved.path}.`,
          data: { connection, entitySet, key, property, ...saved },
        }
      }),
  )

  server.registerTool(
    'download_attached_file',
    {
      title: 'Download an attached file',
      description:
        "Save a file attached to a 1С object (a record of a Catalog_*ПрисоединенныеФайлы set, e.g. Catalog_ПоступлениеТоваровУслугПрисоединенныеФайлы) to the download directory. Follows the БСП chain: file card → InformationRegister_ХранилищеФайлов → Catalog_ХранилищеДвоичныхДанных.ДвоичныеДанные, falling back to the card's own ФайлХранилище. Checks the size and hash against what 1С stored. Returns the path, size and SHA-256 — never the bytes. Read-only towards 1С. Files stored in volumes (ТипХраненияФайла = ВТомахНаДиске) are not reachable through OData.",
      inputSchema: {
        connection: z.string().describe('Connection name'),
        entitySet: z
          .string()
          .regex(/ПрисоединенныеФайлы$/u, 'entitySet must be a Catalog_*ПрисоединенныеФайлы set')
          .describe('Attached-files catalog, e.g. Catalog_ПоступлениеТоваровУслугПрисоединенныеФайлы'),
        key: z.string().regex(GUID_SHAPE, 'key must be a Ref_Key GUID').describe('Ref_Key of the file card'),
      },
    },
    async ({ connection, entitySet, key }) =>
      toolResult(async () => {
        const card = await readFileCard(pool, connection, entitySet, key)
        const dir = join(resolveDownloadDir(opts.dataDir), safeFileName(connection))
        const fileName = safeFileName(`${key.slice(0, 8)}_${cardFileName(card)}`)
        const { saved, source, storedHash } = await downloadCardContent(pool, connection, entitySet, key, dir, fileName)
        const sizeMatches = card.size === undefined ? null : card.size === saved.bytes
        const hashMatches = storedHash === undefined ? null : storedHash === saved.sha256Base64
        return {
          summary: `Saved "${card.description}" (${saved.bytes} bytes) to ${saved.path}.${checkWarning(sizeMatches, hashMatches, card.size)}`,
          data: {
            connection,
            entitySet,
            key,
            description: card.description,
            extension: card.extension,
            ownerKey: card.ownerKey,
            source,
            expectedSize: card.size,
            sizeMatches,
            storedHash,
            hashMatches,
            ...saved,
          },
        }
      }),
  )
}
