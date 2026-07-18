import {
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWK,
  errors as joseErrors,
  jwtVerify,
  SignJWT,
} from 'jose'
import { describe, expect, it } from 'vitest'
import { createLocalJwks } from '../../src/auth/verifier.js'

const ISSUER = 'https://mcp.example.com/api/auth'
const AUDIENCE = 'https://mcp.example.com/mcp'

interface Signer {
  jwk: JWK
  sign(): Promise<string>
}

/** An Ed25519 key pair plus a token-minting helper, mirroring what the AS signs. */
async function makeSigner(kid: string): Promise<Signer> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true })
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' }
  return {
    jwk,
    sign: () =>
      new SignJWT({})
        .setProtectedHeader({ alg: 'EdDSA', kid })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setSubject('user-1')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey),
  }
}

/** A reader over a MUTABLE key set, counting how often the verifier reads it. */
function countingReader(initial: JWK[]): {
  read: () => Promise<JSONWebKeySet>
  calls: () => number
  set(k: JWK[]): void
} {
  let keys = initial
  let calls = 0
  return {
    read: async () => {
      calls++
      return { keys }
    },
    calls: () => calls,
    set: (k) => {
      keys = k
    },
  }
}

const verify = async (token: string, keys: Awaited<ReturnType<ReturnType<typeof createLocalJwks>>>) =>
  jwtVerify(token, keys, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['EdDSA'] })

describe('createLocalJwks', () => {
  it('verifies a token against the in-process key set', async () => {
    const a = await makeSigner('key-a')
    const reader = countingReader([a.jwk])
    const jwks = createLocalJwks(reader.read)

    const { payload } = await verify(await a.sign(), await jwks())
    expect(payload.sub).toBe('user-1')
  })

  it('reads the key set once and caches it across verifications', async () => {
    const a = await makeSigner('key-a')
    const reader = countingReader([a.jwk])
    const jwks = createLocalJwks(reader.read)

    await verify(await a.sign(), await jwks())
    await verify(await a.sign(), await jwks())

    expect(reader.calls()).toBe(1)
  })

  it('reloads on an unknown kid so a rotated AS key is picked up', async () => {
    const a = await makeSigner('key-a')
    const b = await makeSigner('key-b')
    const reader = countingReader([a.jwk])
    const jwks = createLocalJwks(reader.read, 0) // no cooldown

    await verify(await a.sign(), await jwks()) // warm the cache with key-a only
    expect(reader.calls()).toBe(1)

    reader.set([a.jwk, b.jwk]) // the AS rotated in a second key
    const { payload } = await verify(await b.sign(), await jwks())

    expect(payload.sub).toBe('user-1')
    expect(reader.calls()).toBe(2)
  })

  it('does not reload within the cooldown — a bogus kid stays one read, not one per request', async () => {
    const a = await makeSigner('key-a')
    const stranger = await makeSigner('key-unknown')
    const reader = countingReader([a.jwk])
    const jwks = createLocalJwks(reader.read, 60_000)

    await verify(await a.sign(), await jwks())
    await expect(verify(await stranger.sign(), await jwks())).rejects.toThrow(joseErrors.JWKSNoMatchingKey)
    await expect(verify(await stranger.sign(), await jwks())).rejects.toThrow(joseErrors.JWKSNoMatchingKey)

    expect(reader.calls()).toBe(1)
  })

  it('still rejects an unknown kid after reloading, without hiding the error', async () => {
    const a = await makeSigner('key-a')
    const stranger = await makeSigner('key-unknown')
    const reader = countingReader([a.jwk])
    const jwks = createLocalJwks(reader.read, 0)

    await verify(await a.sign(), await jwks())
    await expect(verify(await stranger.sign(), await jwks())).rejects.toThrow(joseErrors.JWKSNoMatchingKey)
    expect(reader.calls()).toBe(2) // it DID try a reload
  })

  it('a rotation lands without rejecting the requests in flight, on ONE shared reload', async () => {
    // The requests in flight when a key rotates in all miss on the new `kid`. They
    // must share a single reload and all retry against the set it installs —
    // rate-limiting the RETRY instead would 401 valid, correctly-signed tokens.
    const a = await makeSigner('key-a')
    const b = await makeSigner('key-b')
    const reader = countingReader([a.jwk])
    const jwks = createLocalJwks(reader.read, 0)

    await verify(await a.sign(), await jwks()) // warm the cache with key-a only
    reader.set([a.jwk, b.jwk]) // the AS rotates key-b in

    const tokens = await Promise.all(Array.from({ length: 25 }, () => b.sign()))
    const results = await Promise.allSettled(tokens.map(async (t) => verify(t, await jwks())))

    expect(results.filter((r) => r.status === 'rejected')).toEqual([])
    expect(reader.calls()).toBe(2) // the initial load + ONE shared reload, not 25
  })

  it('refreshes a stale set, so a key the operator removed stops verifying', async () => {
    // An unknown-kid reload only ever picks keys UP; the max-age refresh is what
    // bounds how long a REVOKED key keeps verifying.
    const a = await makeSigner('key-a')
    const b = await makeSigner('key-b')
    const reader = countingReader([a.jwk, b.jwk])
    const jwks = createLocalJwks(reader.read, 60_000, 0) // maxAge 0 → always stale

    await verify(await b.sign(), await jwks()) // key-b verifies while it is published
    expect(reader.calls()).toBe(1)

    reader.set([a.jwk]) // key-b revoked at the AS
    await expect(verify(await b.sign(), await jwks())).rejects.toThrow(joseErrors.JWKSNoMatchingKey)
    expect(reader.calls()).toBe(2)
  })

  it('keeps the last good set when a stale refresh fails', async () => {
    const a = await makeSigner('key-a')
    let fail = false
    const jwks = createLocalJwks(
      async () => {
        if (fail) throw new Error('db down')
        return { keys: [a.jwk] }
      },
      60_000,
      0, // always stale → every verification attempts a refresh
    )

    await verify(await a.sign(), await jwks())
    fail = true
    const { payload } = await verify(await a.sign(), await jwks()) // refresh fails, old set survives
    expect(payload.sub).toBe('user-1')
  })

  it('does not poison the cache when the read fails', async () => {
    const a = await makeSigner('key-a')
    let fail = true
    const jwks = createLocalJwks(async () => {
      if (fail) throw new Error('db down')
      return { keys: [a.jwk] }
    })

    // The first load has nothing to fall back on, so its failure propagates.
    await expect(verify(await a.sign(), await jwks())).rejects.toThrow('db down')
    fail = false
    const { payload } = await verify(await a.sign(), await jwks())
    expect(payload.sub).toBe('user-1')
  })
})
