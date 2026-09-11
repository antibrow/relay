import { describe, expect, it } from 'vitest'
import vectors from '../src/protocol/vectors.json'
import { decodeInit, encodeInit } from '../src/protocol/frames'

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

describe('init frame', () => {
  it('matches the frozen vector', () => {
    const encoded = encodeInit({ host: 'example.com', port: 443, cred: 'api:pid' })
    expect(hex(encoded)).toBe(vectors.init_example443)
  })

  it('round-trips', () => {
    const decoded = decodeInit(encodeInit({ host: 'a.example', port: 8080, cred: 'u:p' }))
    expect(decoded).toEqual({ ver: 1, host: 'a.example', port: 8080, cred: 'u:p' })
  })

  it('treats a missing cred as the empty string', () => {
    expect(decodeInit(encodeInit({ host: 'h', port: 1 })).cred).toBe('')
  })

  it('rejects a host longer than 255 bytes', () => {
    expect(() => encodeInit({ host: 'a'.repeat(256), port: 1 })).toThrow()
  })

  it('rejects a truncated frame', () => {
    expect(() => decodeInit(new Uint8Array([1, 200, 0x61]))).toThrow()
  })

  it('rejects a version it does not implement', () => {
    const encoded = encodeInit({ host: 'h', port: 1 })
    encoded[0] = 99
    expect(() => decodeInit(encoded)).toThrow()
  })
})
