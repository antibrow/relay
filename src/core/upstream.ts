import { ByteReader, concat } from './bytes'
import type { Connect, RelaySocket } from './types'
import type { Upstream } from './store'

const enc = new TextEncoder()
const dec = new TextDecoder()
const CRLF2 = enc.encode('\r\n\r\n')
const HEAD_LIMIT = 16384

export interface DialResult {
  socket: RelaySocket
  /** Bytes that arrived after the upstream handshake and belong to the tunnel.
   *  Dropping these shows up much later as a stalled TLS handshake. */
  leftover: Uint8Array
}

export async function dial(up: Upstream, host: string, port: number, connect: Connect): Promise<DialResult> {
  if (up.protocol === 'direct') {
    const socket = connect(host, port)
    await socket.opened
    return { socket, leftover: new Uint8Array(0) }
  }
  if (!up.host || !up.port) throw new Error('upstream is missing host or port')

  const socket = connect(up.host, up.port)
  await socket.opened
  const reader = new ByteReader(socket.readable)
  // Releases live in finally, not after the call: the writer acquisition itself can throw.
  try {
    const writer = socket.writable.getWriter()
    try {
      const leftover = up.protocol === 'http'
        ? await httpConnect(reader, writer, up, host, port)
        : await socks5Connect(reader, writer, up, host, port)
      return { socket, leftover }
    } finally {
      writer.releaseLock()
    }
  } catch (e) {
    socket.close()
    throw e
  } finally {
    reader.release()
  }
}

async function httpConnect(
  reader: ByteReader,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  up: Upstream,
  host: string,
  port: number,
): Promise<Uint8Array> {
  const target = `${host}:${port}`
  const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`]
  if (up.username) lines.push(`Proxy-Authorization: Basic ${btoa(`${up.username}:${up.password ?? ''}`)}`)
  await writer.write(enc.encode(`${lines.join('\r\n')}\r\n\r\n`))
  const { head, rest } = await reader.readUntilSeq(CRLF2, HEAD_LIMIT)
  const status = Number(dec.decode(head).split('\r\n')[0]?.split(' ')[1])
  if (!(status >= 200 && status < 300)) throw new Error(`upstream refused CONNECT with ${status}`)
  return rest
}

async function socks5Connect(
  reader: ByteReader,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  up: Upstream,
  host: string,
  port: number,
): Promise<Uint8Array> {
  const hasAuth = Boolean(up.username)
  // Offer both methods when we have credentials: some upstreams answer 0x00 even
  // when configured with a password, and refusing that would be our bug.
  await writer.write(hasAuth ? new Uint8Array([5, 2, 0, 2]) : new Uint8Array([5, 1, 0]))
  await reader.readAtLeast(2)
  const greet = reader.take(2)
  if (greet[0] !== 5) throw new Error('upstream did not answer as socks5')
  if (greet[1] === 2) {
    if (!hasAuth) throw new Error('upstream demands credentials the upstream row does not have')
    const u = enc.encode(up.username ?? '')
    const p = enc.encode(up.password ?? '')
    await writer.write(concat([new Uint8Array([1, u.length]), u, new Uint8Array([p.length]), p]))
    await reader.readAtLeast(2)
    if (reader.take(2)[1] !== 0) throw new Error('upstream rejected credentials')
  } else if (greet[1] !== 0) {
    throw new Error(`upstream offered no acceptable auth method (0x${greet[1]?.toString(16)})`)
  }

  // ATYP 3 (domain) rather than resolving locally: the exit should do its own DNS,
  // otherwise the resolver location and the exit IP disagree.
  const h = enc.encode(host)
  if (h.length > 255) throw new Error('host too long for socks5')
  const portBe = new Uint8Array(2)
  new DataView(portBe.buffer).setUint16(0, port, false)
  await writer.write(concat([new Uint8Array([5, 1, 0, 3, h.length]), h, portBe]))

  await reader.readAtLeast(5)
  const head = reader.take(4) // ver | rep | rsv | atyp
  if (head[1] !== 0) throw new Error(`upstream refused connect, rep ${head[1]}`)
  const atyp = head[3]
  const addrLen = atyp === 1 ? 4 : atyp === 4 ? 16 : reader.take(1)[0] ?? 0
  await reader.readAtLeast(addrLen + 2)
  reader.take(addrLen + 2)
  return reader.leftover()
}
