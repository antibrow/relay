import net from 'node:net'
import { Duplex } from 'node:stream'
import type { Connect } from '../core/types'

export const nodeConnect: Connect = (host, port) => {
  const sock = net.connect(port, host)
  const opened = new Promise<void>((resolve, reject) => {
    sock.once('connect', () => resolve())
    sock.once('error', reject)
  })
  // Errors after the connect phase are reported through the streams; without a
  // listener here Node turns a late ECONNRESET into an uncaught exception.
  sock.on('error', () => {})
  const web = Duplex.toWeb(sock)
  return {
    readable: web.readable as ReadableStream<Uint8Array>,
    writable: web.writable as WritableStream<Uint8Array>,
    opened,
    close: () => sock.destroy(),
  }
}
