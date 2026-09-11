// Init frame wire format (all integers big-endian):
//   ver:u8 | hostLen:u8 | host | port:u16 | credLen:u16 | cred
// host/port are the final target the client wants; cred carries the relay
// account identity and is opaque at this layer.

const enc = new TextEncoder()
const dec = new TextDecoder()

export const INIT_VER = 1
export const STATUS_OK = 0x00

export interface Init {
  ver: number
  host: string
  port: number
  cred: string
}

export function encodeInit(i: { host: string; port: number; cred?: string }): Uint8Array {
  const host = enc.encode(i.host)
  const cred = enc.encode(i.cred ?? '')
  if (host.length > 255) throw new Error('host too long')
  const out = new Uint8Array(1 + 1 + host.length + 2 + 2 + cred.length)
  const dv = new DataView(out.buffer)
  let o = 0
  out[o++] = INIT_VER
  out[o++] = host.length
  out.set(host, o)
  o += host.length
  dv.setUint16(o, i.port, false)
  o += 2
  dv.setUint16(o, cred.length, false)
  o += 2
  out.set(cred, o)
  return out
}

export function decodeInit(bytes: Uint8Array): Init {
  const need = (n: number) => {
    if (bytes.length < n) throw new Error('init frame truncated')
  }
  need(2)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let o = 0
  const ver = bytes[o++]!
  if (ver !== INIT_VER) throw new Error(`unsupported init version ${ver}`)
  const hostLen = bytes[o++]!
  need(2 + hostLen + 4)
  const host = dec.decode(bytes.subarray(o, o + hostLen))
  o += hostLen
  const port = dv.getUint16(o, false)
  o += 2
  const credLen = dv.getUint16(o, false)
  o += 2
  need(o + credLen)
  return { ver, host, port, cred: dec.decode(bytes.subarray(o, o + credLen)) }
}
