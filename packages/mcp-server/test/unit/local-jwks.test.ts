import {
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWK,
  errors as joseErrors,
  jwtVerify,
  SignJWT,
} from 'jose'
import { describe, expect, it, vi } from 'vitest'
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
    const jwks = createLocalJwks(reader.read, { cooldownMs: 0 }) // no cooldown

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
    const jwks = createLocalJwks(reader.read, { cooldownMs: 60_000 })

    await verify(await a.sign(), await jwks())
    await expect(verify(await stranger.sign(), await jwks())).rejects.toThrow(joseErrors.JWKSNoMatchingKey)
    await expect(verify(await stranger.sign(), await jwks())).rejects.toThrow(joseErrors.JWKSNoMatchingKey)

    expect(reader.calls()).toBe(1)
  })

  it('still rejects an unknown kid after reloading, without hiding the error', async () => {
    const a = await makeSigner('key-a')
    const stranger = await makeSigner('key-unknown')
    const reader = countingReader([a.jwk])
    const jwks = createLocalJwks(reader.read, { cooldownMs: 0 })

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
    const jwks = createLocalJwks(reader.read, { cooldownMs: 0 })

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
    const jwks = createLocalJwks(reader.read, { cooldownMs: 60_000, maxAgeMs: 0 }) // always stale

    await verify(await b.sign(), await jwks()) // key-b verifies while it is published
    expect(reader.calls()).toBe(1)

    reader.set([a.jwk]) // key-b revoked at the AS
    await expect(verify(await b.sign(), await jwks())).rejects.toThrow(joseErrors.JWKSNoMatchingKey)
    expect(reader.calls()).toBe(2)
  })

  it('keeps the last good set when a stale refresh fails, and throttles the retries', async () => {
    const a = await makeSigner('key-a')
    let fail = false
    let reads = 0
    const jwks = createLocalJwks(
      async () => {
        reads++
        if (fail) throw new Error('db down')
        return { keys: [a.jwk] }
      },
      {
        cooldownMs: 60_000, // a FAILED stale refresh is retried at most this often
        maxAgeMs: 0, // always stale → every verification is eligible for a refresh
      },
    )

    await verify(await a.sign(), await jwks()) // initial load
    expect(reads).toBe(1)

    fail = true
    // Three verifications during the "outage": the set stays usable, and the DB is
    // read at most once (the first attempt) — not once per verification.
    for (let i = 0; i < 3; i++) {
      const { payload } = await verify(await a.sign(), await jwks())
      expect(payload.sub).toBe('user-1')
    }
    expect(reads).toBe(2)
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

  it('abandons a read that HANGS instead of holding every bearer check forever', async () => {
    // The reload promise is shared by every concurrent verification, so a read that
    // never settles — not one that fails — is what would wedge the whole auth path.
    const a = await makeSigner('key-a')
    const jwks = createLocalJwks(() => new Promise<JSONWebKeySet>(() => {}), { timeoutMs: 20 })

    await expect(verify(await a.sign(), await jwks())).rejects.toThrow(/Timed out reading the JWKS/)
  })

  it('retries after a timed-out read rather than staying wedged', async () => {
    const a = await makeSigner('key-a')
    let hang = true
    let reads = 0
    const jwks = createLocalJwks(
      () => {
        reads++
        return hang ? new Promise<JSONWebKeySet>(() => {}) : Promise.resolve({ keys: [a.jwk] })
      },
      { timeoutMs: 20 },
    )

    await expect(verify(await a.sign(), await jwks())).rejects.toThrow(/Timed out/)
    hang = false
    const { payload } = await verify(await a.sign(), await jwks())
    expect(payload.sub).toBe('user-1')
    expect(reads).toBe(2) // the abandoned read, then a genuinely NEW one
  })

  it('defaults the read deadline to 5s', async () => {
    // Pin the shipped default: too short would 401 healthy requests, too long would
    // restore the wedge this bound exists to prevent. Every other timeout test
    // overrides `timeoutMs`, so without this the constant is unverified.
    vi.useFakeTimers()
    try {
      const jwks = createLocalJwks(() => new Promise<JSONWebKeySet>(() => {}))
      const resolver = await jwks()
      const attempt = resolver()
      const settled = expect(attempt).rejects.toThrow('Timed out reading the JWKS after 5000ms')
      await vi.advanceTimersByTimeAsync(5_000)
      await settled
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps serving the last good set when a stale refresh HANGS', async () => {
    const a = await makeSigner('key-a')
    let hang = false
    const jwks = createLocalJwks(
      () => (hang ? new Promise<JSONWebKeySet>(() => {}) : Promise.resolve({ keys: [a.jwk] })),
      {
        maxAgeMs: 0, // always stale → every verification attempts a refresh
        timeoutMs: 20,
      },
    )

    await verify(await a.sign(), await jwks()) // initial load
    hang = true
    const { payload } = await verify(await a.sign(), await jwks()) // refresh times out, old set survives
    expect(payload.sub).toBe('user-1')
  })

  it('clears the read timeout, leaving no timer behind', async () => {
    const a = await makeSigner('key-a')
    const token = await a.sign()
    vi.useFakeTimers()
    try {
      const jwks = createLocalJwks(async () => ({ keys: [a.jwk] }))
      await verify(token, await jwks())
      expect(vi.getTimerCount()).toBe(0) // a live timer would hold the event loop open
    } finally {
      vi.useRealTimers()
    }
  })
})
