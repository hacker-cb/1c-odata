// src/store/crypto.ts
/**
 * AES-256-GCM at-rest encryption for 1С passwords. The security-load-bearing
 * property: AAD = [FORMAT_VERSION, keyId, utf8(baseName)], so a sealed row is
 * cryptographically bound to its base — an attacker with DB write access cannot
 * move base A's (nonce, ciphertext, tag) into base B's row; decrypt-as-B fails
 * the GCM tag. Each sealed row records the `keyId` that sealed it, so rotation is
 * decrypt-old / encrypt-current: {@link loadKeyring} loads the current KEK plus any
 * retired ones, {@link decrypt} picks the KEK by the row's `keyId`, and
 * {@link encrypt} always seals with the current one.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const NONCE_LEN = 12 // GCM standard 96-bit IV
const TAG_LEN = 16 // GCM 128-bit tag
const KEY_LEN = 32 // AES-256
const FORMAT_VERSION = 1 // bumped only on envelope-layout change, not on KEK rotation

/** A sealed secret — maps 1:1 to the four `base_secrets` crypto columns. Never plaintext. */
export interface SealedSecret {
  /** KEK version (0..255). The `key_id` column. */
  keyId: number
  /** 96-bit random IV. The `nonce` column. */
  nonce: Buffer
  /** AES-256-GCM output. The `ciphertext` column. */
  ciphertext: Buffer
  /** 128-bit GCM tag. The `tag` column. */
  tag: Buffer
}

/** One KEK plus the id it is addressed by. */
export interface Kek {
  id: number
  key: Buffer
}

/** The set of KEKs this process can decrypt with, plus the one it encrypts with. */
export interface Keyring {
  /** KEK used for new encryptions. */
  current: Kek
  /** Every KEK this process can decrypt with — the current one plus any retired ones. */
  byId: ReadonlyMap<number, Kek>
}

/** KEK material missing/misshapen — a config error; fail loud at boot. */
export class MissingEncryptionKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MissingEncryptionKeyError'
  }
}

/**
 * GCM authentication failed: wrong KEK, tampered bytes, or a cross-base-swapped
 * blob (AAD mismatch). Carries NO plaintext, NO key material, and a deliberately
 * coarse message — the three causes are INDISTINGUISHABLE by design (no oracle).
 */
export class DecryptionError extends Error {
  constructor(
    message: string,
    readonly baseName: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'DecryptionError'
  }
}

/**
 * Build the keyring from env:
 *   - `ONEC_MCP_ENC_KEY` — the CURRENT KEK (base64 32-byte); everything new is
 *     sealed with it. `ONEC_MCP_ENC_KEY_ID` (default 1) is its id.
 *   - `ONEC_MCP_ENC_KEYS_PREVIOUS` — optional `id:key[,id:key…]` of RETIRED KEKs,
 *     loaded for decryption only. This is what makes rotation possible: point
 *     `ONEC_MCP_ENC_KEY` at the new key (with a new id), move the old one here, and
 *     rows sealed under it stay readable.
 *
 * Throws {@link MissingEncryptionKeyError} at boot on anything malformed — a bad KEK
 * must fail loudly, never silently corrupt writes or strand secrets. In prod the raw
 * material comes from a KMS/Vault-injected env var.
 *
 * Rotation is lazy: a row is re-sealed under the current KEK when its password is
 * next saved. A retired key must therefore stay in `ONEC_MCP_ENC_KEYS_PREVIOUS`
 * until every base has been re-saved — dropping it early strands those secrets.
 */
export function loadKeyring(env: NodeJS.ProcessEnv = process.env): Keyring {
  const raw = env.ONEC_MCP_ENC_KEY?.trim()
  if (raw === undefined || raw === '') {
    throw new MissingEncryptionKeyError(
      'ONEC_MCP_ENC_KEY is not set. Provide a base64-encoded 32-byte AES-256 key ' +
        '(generate one with: `openssl rand -base64 32`).',
    )
  }
  const key = decodeKey(raw, 'ONEC_MCP_ENC_KEY')
  const id = parseKeyId(env.ONEC_MCP_ENC_KEY_ID)
  const current: Kek = { id, key }
  const byId = new Map<number, Kek>([[id, current]])
  for (const kek of parsePreviousKeys(env.ONEC_MCP_ENC_KEYS_PREVIOUS)) {
    // A retired id colliding with the current one is always a config mistake: it
    // would silently shadow (or be shadowed by) the encrypting key. Fail loudly
    // rather than guess which the operator meant.
    if (byId.has(kek.id)) {
      throw new MissingEncryptionKeyError(
        `ONEC_MCP_ENC_KEYS_PREVIOUS repeats key id ${kek.id}, which is already in use ` +
          '(ids must be unique across ONEC_MCP_ENC_KEY_ID and the retired keys).',
      )
    }
    byId.set(kek.id, kek)
  }
  return { current, byId }
}

/**
 * Parse `ONEC_MCP_ENC_KEYS_PREVIOUS` — `id:base64key` pairs, comma-separated. Absent
 * or blank ⇒ no retired keys (the pre-rotation default). The `id:` prefix is required
 * because the id is what the sealed row records; it cannot be inferred from the key.
 */
function parsePreviousKeys(raw: string | undefined): Kek[] {
  const trimmed = raw?.trim()
  if (trimmed === undefined || trimmed === '') return []
  return trimmed.split(',').map((entry) => {
    // Split on the FIRST colon only: base64 never contains ':', but being explicit
    // keeps a stray one in the key from being read as a separator.
    const at = entry.indexOf(':')
    if (at === -1) {
      throw new MissingEncryptionKeyError(
        `ONEC_MCP_ENC_KEYS_PREVIOUS entry ${JSON.stringify(entry.trim())} is not "id:key" ` +
          '(expected e.g. "1:BASE64KEY,0:OLDERBASE64KEY").',
      )
    }
    const id = parseKeyId(entry.slice(0, at), 'ONEC_MCP_ENC_KEYS_PREVIOUS')
    return { id, key: decodeKey(entry.slice(at + 1).trim(), `ONEC_MCP_ENC_KEYS_PREVIOUS key id ${id}`) }
  })
}

function decodeKey(b64: string, varName: string): Buffer {
  // Node's base64 decoder is lenient (it silently drops non-alphabet chars), so a
  // junk string can still decode to some bytes. Re-encoding and comparing lengths
  // via the byte count below is the actual gate: a non-32-byte result is rejected.
  const key = Buffer.from(b64, 'base64')
  if (key.length !== KEY_LEN) {
    throw new MissingEncryptionKeyError(`${varName} decodes to ${key.length} bytes; a 32-byte AES-256 key is required.`)
  }
  return key
}

/**
 * A KEK id: an integer 0..255 (the `key_id` column's width, and it is folded into the
 * AAD as one byte). Blank ⇒ 1, the default for `ONEC_MCP_ENC_KEY_ID` on a store that
 * predates any rotation.
 */
function parseKeyId(raw: string | undefined, varName = 'ONEC_MCP_ENC_KEY_ID'): number {
  const trimmed = raw?.trim()
  const id = trimmed ? Number(trimmed) : 1
  if (!Number.isInteger(id) || id < 0 || id > 255) {
    throw new MissingEncryptionKeyError(`${varName} must be an integer 0..255 (got ${JSON.stringify(raw)}).`)
  }
  return id
}

/**
 * Seal `plaintext` for `baseName`. Fresh random 96-bit nonce; AAD binds the
 * ciphertext to (format version, keyId, base name). Encrypts with the CURRENT
 * KEK; the returned keyId records which, so a later rotation can still decrypt.
 */
export function encrypt(keyring: Keyring, baseName: string, plaintext: string): SealedSecret {
  const { id, key } = keyring.current
  const nonce = randomBytes(NONCE_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN })
  cipher.setAAD(aad(id, baseName))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return { keyId: id, nonce, ciphertext, tag }
}

/**
 * Unseal for `baseName`. Selects the KEK by `sealed.keyId`, re-derives the SAME
 * AAD, verifies the GCM tag. Unknown keyId → {@link DecryptionError}; any tag
 * failure (wrong key / tampered bytes / cross-base swap → AAD ≠ baseName) → node
 * throws from `final()`, caught and collapsed to one coarse DecryptionError.
 */
export function decrypt(keyring: Keyring, baseName: string, sealed: SealedSecret): string {
  const kek = keyring.byId.get(sealed.keyId)
  if (kek === undefined) {
    throw new DecryptionError(`No KEK for key_id ${sealed.keyId}`, baseName)
  }
  try {
    // Inside the try: a malformed-LENGTH nonce or tag (corruption / a tampered
    // DB column) makes createDecipheriv/setAuthTag throw a generic TypeError, not
    // a tag-mismatch. Collapsing every such failure to one DecryptionError keeps
    // the no-oracle contract (a length error must be indistinguishable from a
    // wrong-key/tampered-bytes error) and never leaks a raw crypto message.
    const decipher = createDecipheriv('aes-256-gcm', kek.key, sealed.nonce, { authTagLength: TAG_LEN })
    decipher.setAAD(aad(sealed.keyId, baseName))
    decipher.setAuthTag(sealed.tag)
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8')
  } catch (cause) {
    throw new DecryptionError('Secret authentication failed', baseName, cause)
  }
}

/**
 * AAD = [FORMAT_VERSION][keyId][utf8(baseName)] as raw bytes (no JSON — avoids
 * canonicalization ambiguity). Folding keyId + version in additionally blocks a
 * silent key-downgrade; the base_name binding is the plan's core requirement.
 */
function aad(keyId: number, baseName: string): Buffer {
  const header = Buffer.from([FORMAT_VERSION, keyId & 0xff])
  return Buffer.concat([header, Buffer.from(baseName, 'utf8')])
}
