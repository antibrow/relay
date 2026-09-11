import type { Upstream } from './store'
import type { Connect, RelaySocket, RelayWs } from './types'
import { dial } from './upstream'

export const READY = 'READY'

/**
 * Plaintext tunnel: one WebSocket connection to one upstream TCP connection,
 * raw bytes both ways, no framing and no encryption.
 *
 * READY is sent only after the upstream is connected. The client takes it as
 * permission to start its TLS handshake, so an early READY turns into a race
 * where the ClientHello arrives before there is anywhere to put it.
 *
 * Inbound writes are serialized through one chain whose first link is the dial
 * itself, the same way the encrypted session's recvChain works: every message
 * that arrives while the dial is in flight just becomes the next link, so it
 * waits its turn without a separate queue.
 */
export function startLegacyTunnel(
  ws: RelayWs,
  opts: { host: string; port: number; upstream: Upstream; connect: Connect },
): void {
  let socket: RelaySocket | undefined
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined
  let clientGone = false

  async function pumpUpstream(from: RelaySocket): Promise<void> {
    const reader = from.readable.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) ws.send(value)
      }
    } catch {
      // upstream read error: fall through to the close below
    }
    ws.close()
  }

  let chain: Promise<void> = (async () => {
    const dialed = await dial(opts.upstream, opts.host, opts.port, opts.connect)
    socket = dialed.socket
    // The client can vanish mid-dial, in which case onClose already ran while socket
    // was still undefined and nothing else would ever close the upstream.
    if (clientGone) {
      socket.close()
      return
    }
    writer = socket.writable.getWriter()
    ws.send(READY)
    // Bytes the upstream handshake read past its own terminator belong to the
    // tunnel and must reach the client before anything the pump reads.
    if (dialed.leftover.length) ws.send(dialed.leftover)
    void pumpUpstream(socket)
  })().catch(() => { ws.close() })

  ws.onMessage((data) => {
    if (typeof data === 'string') { ws.close(); return }
    const buf = new Uint8Array(data)
    chain = chain.then(async () => {
      if (!writer) { ws.close(); return }
      await writer.write(buf)
    }).catch(() => ws.close())
  })
  ws.onClose(() => {
    clientGone = true
    try { socket?.close() } catch { /* already gone */ }
  })
}
