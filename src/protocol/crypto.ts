// fp-relay/1 cryptography: HKDF-SHA256 derives one AES-256-GCM key per direction,
// then every frame is sealed under a monotonic per-direction counter nonce.
// Byte-compatible with the AntiBrow kernel's implementation - the strings below
// are cryptographic inputs, so changing one byte breaks interoperability.

const enc = new TextEncoder()

export const PSK_LEN = 32
export const SALT_LEN = 32
export const MAX_PLAINTEXT = 16384
export const AAD = enc.encode('fp-relay/1')

const INFO_C2S = enc.encode('fp-relay/1 c2s')
const INFO_S2C = enc.encode('fp-relay/1 s2c')

// atob/btoa rather than Buffer: this module has to run unchanged on Workers.
export function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replaceAll('-', '+').replaceAll('_', '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  const bin = atob(b64 + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToBase64Url(b: Uint8Array): string {
  let bin = ''
  for (const byte of b) bin += String.fromCharCode(byte)
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export function keyFromBase64Url(s: string): Uint8Array {
  const raw = base64UrlToBytes(s)
  if (raw.length !== PSK_LEN) {
    throw new Error(`relay key must decode to ${PSK_LEN} bytes, got ${raw.length}`)
  }
  return raw
}

export function randomKeyBase64Url(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(PSK_LEN)))
}

async function hkdf32(psk: Uint8Array, salt: Uint8Array, info: Uint8Array): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey('raw', psk as BufferSource, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource }, ikm, 256)
  return new Uint8Array(bits)
}

const importAesGcm = (raw: Uint8Array) =>
  crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])

export async function deriveKeys(psk: Uint8Array, salt: Uint8Array) {
  return {
    c2s: await importAesGcm(await hkdf32(psk, salt, INFO_C2S)),
    s2c: await importAesGcm(await hkdf32(psk, salt, INFO_S2C)),
  }
}

export function nonce(counter: bigint): Uint8Array {
  const n = new Uint8Array(12) // 0x00000000 || uint64be(counter)
  new DataView(n.buffer).setBigUint64(4, counter, false)
  return n
}

export async function seal(key: CryptoKey, counter: bigint, plaintext: Uint8Array): Promise<Uint8Array> {
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce(counter) as BufferSource, additionalData: AAD as BufferSource, tagLength: 128 }, key, plaintext as BufferSource)
  return new Uint8Array(ct)
}

export async function open(key: CryptoKey, counter: bigint, ciphertext: Uint8Array): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce(counter) as BufferSource, additionalData: AAD as BufferSource, tagLength: 128 }, key, ciphertext as BufferSource)
  return new Uint8Array(pt)
}
