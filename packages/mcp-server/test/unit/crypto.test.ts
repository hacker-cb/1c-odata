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

describe('KEK rotation', () => {
  /** Post-rotation: KEY_B is current under id 2, KEY_A retired under id 1. */
  function rotated(): Keyring {
    return loadKeyring({
      ONEC_MCP_ENC_KEY: KEY_B,
      ONEC_MCP_ENC_KEY_ID: '2',
      ONEC_MCP_ENC_KEYS_PREVIOUS: `1:${KEY_A}`,
    } as NodeJS.ProcessEnv)
  }

  it('reads a row sealed under the retired KEK and seals new ones under the current one', () => {
    // Sealed BEFORE the rotation, under KEY_A / id 1.
    const old = encrypt(keyringFrom(KEY_A, '1'), 'Trade', 'old-secret')
    expect(old.keyId).toBe(1)

    const kr = rotated()
    // decrypt-old: the retired KEK is selected by the row's key_id.
    expect(decrypt(kr, 'Trade', old)).toBe('old-secret')
    // encrypt-current: anything new is sealed under the NEW key, never the retired one.
    const fresh = encrypt(kr, 'Trade', 'new-secret')
    expect(fresh.keyId).toBe(2)
    expect(decrypt(kr, 'Trade', fresh)).toBe('new-secret')
  })

  it('re-sealing a row under the current KEK is what lets the retired one be dropped (lazy rotation)', () => {
    const kr = rotated()
    const old = encrypt(keyringFrom(KEY_A, '1'), 'Trade', 's3cret')
    // A save re-seals: decrypt with the full ring, encrypt with current.
    const resealed = encrypt(kr, 'Trade', decrypt(kr, 'Trade', old))
    expect(resealed.keyId).toBe(2)
    // Once every row is re-sealed, the retired key can leave the env entirely.
    const currentOnly = keyringFrom(KEY_B, '2')
    expect(decrypt(currentOnly, 'Trade', resealed)).toBe('s3cret')
    // ...and the un-migrated row is exactly what would strand — hence "drop it only
    // once every base has been re-saved".
    expect(() => decrypt(currentOnly, 'Trade', old)).toThrow(DecryptionError)
  })

  it('the retired KEK is decrypt-only — the AAD still binds each row to its own key id', () => {
    const kr = rotated()
    const old = encrypt(keyringFrom(KEY_A, '1'), 'Trade', 'x')
    // Claiming the row was sealed under the CURRENT id fails: keyId is in the AAD.
    expect(() => decrypt(kr, 'Trade', { ...old, keyId: 2 })).toThrow(DecryptionError)
  })

  it('loads several retired KEKs', () => {
    const KEY_C = Buffer.alloc(32, 3).toString('base64')
    const kr = loadKeyring({
      ONEC_MCP_ENC_KEY: KEY_C,
      ONEC_MCP_ENC_KEY_ID: '3',
      ONEC_MCP_ENC_KEYS_PREVIOUS: `1:${KEY_A}, 2:${KEY_B}`,
    } as NodeJS.ProcessEnv)
    expect(decrypt(kr, 'Trade', encrypt(keyringFrom(KEY_A, '1'), 'Trade', 'a'))).toBe('a')
    expect(decrypt(kr, 'Trade', encrypt(keyringFrom(KEY_B, '2'), 'Trade', 'b'))).toBe('b')
    expect(encrypt(kr, 'Trade', 'c').keyId).toBe(3)
  })

  it('absent / blank ONEC_MCP_ENC_KEYS_PREVIOUS is the un-rotated default', () => {
    expect(loadKeyring({ ONEC_MCP_ENC_KEY: KEY_A } as NodeJS.ProcessEnv).byId.size).toBe(1)
    expect(
      loadKeyring({ ONEC_MCP_ENC_KEY: KEY_A, ONEC_MCP_ENC_KEYS_PREVIOUS: '  ' } as NodeJS.ProcessEnv).byId.size,
    ).toBe(1)
  })

  it('fails loud on a malformed retired-key list rather than silently stranding secrets', () => {
    const previous =
      (v: string): (() => Keyring) =>
      () =>
        loadKeyring({
          ONEC_MCP_ENC_KEY: KEY_B,
          ONEC_MCP_ENC_KEY_ID: '2',
          ONEC_MCP_ENC_KEYS_PREVIOUS: v,
        } as NodeJS.ProcessEnv)
    expect(previous(KEY_A)).toThrow(/not "id:key"/) // missing the id: prefix
    expect(previous(`1:${Buffer.alloc(16).toString('base64')}`)).toThrow(/32-byte/) // short key
    expect(previous(`999:${KEY_A}`)).toThrow(/0\.\.255/) // id out of range
    expect(previous(`2:${KEY_A}`)).toThrow(/already in use/) // collides with the current id
  })
})
