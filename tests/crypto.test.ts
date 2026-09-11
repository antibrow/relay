import { describe, expect, it } from 'vitest'
import vectors from '../src/protocol/vectors.json'
import {
  AAD, base64UrlToBytes, bytesToBase64Url, deriveKeys, keyFromBase64Url,
  nonce, open, randomKeyBase64Url, seal,
} from '../src/protocol/crypto'

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)))

const psk = unhex(vectors.psk)
const salt = unhex(vectors.salt)
const PLAIN = new TextEncoder().encode('hello relay')

describe('crypto', () => {
  it('seals and opens a roundtrip', async () => {
    const { c2s } = await deriveKeys(psk, salt)
    const ct = await seal(c2s, 1n, PLAIN)
    expect(await open(c2s, 1n, ct)).toEqual(PLAIN)
  })

  it('keeps the two directions isolated', async () => {
    const { c2s, s2c } = await deriveKeys(psk, salt)
    const ct = await seal(c2s, 1n, PLAIN)
    await expect(open(s2c, 1n, ct)).rejects.toThrow()
  })

  it('varies the ciphertext with the counter', async () => {
    const { c2s } = await deriveKeys(psk, salt)
    expect(hex(await seal(c2s, 0n, PLAIN))).not.toEqual(hex(await seal(c2s, 1n, PLAIN)))
  })

  it('builds a nonce as four zero bytes then a big-endian counter', () => {
    expect(hex(nonce(1n))).toBe('000000000000000000000001')
    expect(hex(nonce(258n))).toBe('000000000000000000000102')
  })

  // KAT: the frozen anchor shared with the AntiBrow kernel's C++ implementation.
  // A drift here means the two ends can no longer talk, not that the test is stale.
  it('matches the frozen known-answer vectors', async () => {
    const { c2s } = await deriveKeys(psk, salt)
    expect(hex(await seal(c2s, 1n, PLAIN))).toBe(vectors.ct_c2s_ctr1_hello)
    expect(String.fromCharCode(...AAD)).toBe(vectors.aad)
  })

  it('rejects a key that does not decode to 32 bytes', () => {
    expect(() => keyFromBase64Url('c2hvcnQ')).toThrow()
  })

  it('round-trips base64url without padding', () => {
    const raw = new Uint8Array([251, 255, 190, 0, 1])
    expect(base64UrlToBytes(bytesToBase64Url(raw))).toEqual(raw)
    expect(bytesToBase64Url(raw)).not.toContain('=')
    expect(bytesToBase64Url(raw)).not.toContain('+')
    expect(bytesToBase64Url(raw)).not.toContain('/')
  })

  it('generates a usable 32-byte key', () => {
    expect(keyFromBase64Url(randomKeyBase64Url())).toHaveLength(32)
  })
})
