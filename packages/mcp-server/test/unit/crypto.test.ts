// test/unit/crypto.test.ts
import { describe, expect, it } from 'vitest'
import {
  DecryptionError,
  decrypt,
  encrypt,
  type Keyring,
  loadKeyring,
  MissingEncryptionKeyError,
} from '../../src/store/crypto.js'

function keyringFrom(b64: string, id = '1'): Keyring {
  return loadKeyring({ ONEC_MCP_ENC_KEY: b64, ONEC_MCP_ENC_KEY_ID: id } as NodeJS.ProcessEnv)
}

const KEY_A = Buffer.alloc(32, 7).toString('base64')
const KEY_B = Buffer.alloc(32, 9).toString('base64')

describe('crypto', () => {
  it('round-trips a secret bound to its base', () => {
    const kr = keyringFrom(KEY_A)
    const sealed = encrypt(kr, 'Trade', 'p@ssw0rd')
    expect(sealed.nonce).toHaveLength(12)
    expect(sealed.tag).toHaveLength(16)
    expect(decrypt(kr, 'Trade', sealed)).toBe('p@ssw0rd')
  })

  it('rejects an AAD (base_name) mismatch — cross-base swap', () => {
    const kr = keyringFrom(KEY_A)
    const sealed = encrypt(kr, 'Trade', 'secret')
    // Same bytes, decrypted AS a different base → tag fails.
    expect(() => decrypt(kr, 'Accounting', sealed)).toThrow(DecryptionError)
  })

  it('rejects the wrong key', () => {
    const sealed = encrypt(keyringFrom(KEY_A), 'Trade', 'secret')
    expect(() => decrypt(keyringFrom(KEY_B), 'Trade', sealed)).toThrow(DecryptionError)
  })

  it('rejects a tampered tag', () => {
    const kr = keyringFrom(KEY_A)
    const sealed = encrypt(kr, 'Trade', 'secret')
    sealed.tag.writeUInt8(sealed.tag.readUInt8(0) ^ 0xff, 0)
    expect(() => decrypt(kr, 'Trade', sealed)).toThrow(DecryptionError)
  })

  it('rejects an unknown key_id', () => {
    const kr = keyringFrom(KEY_A)
    const sealed = { ...encrypt(kr, 'Trade', 'secret'), keyId: 99 }
    expect(() => decrypt(kr, 'Trade', sealed)).toThrow(DecryptionError)
  })

  it('collapses a malformed-LENGTH nonce/tag to DecryptionError, not a raw crypto error (C4: no oracle)', () => {
    const kr = keyringFrom(KEY_A)
    // A truncated tag/nonce (corruption or a tampered DB column) makes setAuthTag /
    // createDecipheriv throw a generic TypeError — it must be collapsed to the same
    // coarse DecryptionError as a wrong-value tag, so the two are indistinguishable
    // (no oracle) and no raw crypto message leaks.
    const shortTag = { ...encrypt(kr, 'Trade', 'secret'), tag: Buffer.alloc(8) }
    expect(() => decrypt(kr, 'Trade', shortTag)).toThrow(DecryptionError)
    const shortNonce = { ...encrypt(kr, 'Trade', 'secret'), nonce: Buffer.alloc(0) }
    expect(() => decrypt(kr, 'Trade', shortNonce)).toThrow(DecryptionError)
  })

  it('the coarse DecryptionError leaks no plaintext or key material', () => {
    const kr = keyringFrom(KEY_A)
    const sealed = encrypt(kr, 'Trade', 'super-secret-value')
    const err = (() => {
      try {
        decrypt(keyringFrom(KEY_B), 'Trade', sealed)
      } catch (e) {
        return e as DecryptionError
      }
      throw new Error('expected throw')
    })()
    expect(err.message).toBe('Secret authentication failed')
    expect(err.message).not.toContain('super-secret-value')
    expect(err.message).not.toContain(KEY_A)
    expect(err.message).not.toContain(KEY_B)
  })

  it('loadKeyring fails loud on missing / short / non-base64 key', () => {
    expect(() => loadKeyring({} as NodeJS.ProcessEnv)).toThrow(MissingEncryptionKeyError)
    expect(() => keyringFrom(Buffer.alloc(16).toString('base64'))).toThrow(MissingEncryptionKeyError)
    expect(() => keyringFrom('not base64 !!!')).toThrow(MissingEncryptionKeyError)
  })
})
