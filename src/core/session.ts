import { MAX_PLAINTEXT, SALT_LEN, deriveKeys, open, seal } from '../protocol/crypto'
import { STATUS_OK, decodeInit } from '../protocol/frames'
import { parseCred, resolveIdentity } from './auth'
import type { RelayStore } from './store'
import type { Connect, RelaySocket, RelayWs } from './types'
import { dial } from './upstream'

export interface SessionDeps {
  key: Uint8Array
  store: RelayStore
  connect: Connect
  now?: () => Date
}

/**
 * One WebSocket connection maps to one upstream TCP connection.
 *
 * Both directions are serialized through their own promise chain. Frame nonces
 * are monotonic counters, so a single reordering breaks the AEAD for the rest of
 * the connection:
 *   - recvChain: frame N's entire handling - including, for the first frame, the
 *     upstream dial - completes before N+1 starts. That is also why no queue is
 *     needed for frames that arrive while the dial is in flight: they are simply
 *     the next link in this same chain, and the chain does not advance to them
 *     until the dial (and the write it enables) is done.
 *   - sendChain: client-bound frames go out in the order their counter was
 *     allocated, even though both the upstream reads and seal() are asynchronous;
 *     allocation is synchronous, sealing is not.
 *
 * Every failure path just closes the socket. No protocol reply is ever sent for
 * an error: an observer probing the endpoint learns nothing from it.
 */
export function startEncryptedSession(ws: RelayWs, deps: SessionDeps): void {
  let c2s: CryptoKey | undefined
  let s2c: CryptoKey | undefined
  let socket: RelaySocket | undefined
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined
  let sendCtr = 0n
  let recvCtr = 0n
  let clientGone = false

  let sendChain: Promise<void> = Promise.resolve()
  function sendSealed(counter: bigint, plaintext: Uint8Array): void {
    sendChain = sendChain.then(async () => {
      ws.send(await seal(s2c!, counter, plaintext))
    }).catch(() => ws.close())
  }

  function sendChunked(payload: Uint8Array): void {
    for (let i = 0; i < payload.length; i += MAX_PLAINTEXT) {
      sendSealed(sendCtr++, payload.subarray(i, i + MAX_PLAINTEXT))
    }
  }

  async function pumpUpstream(from: RelaySocket): Promise<void> {
    const reader = from.readable.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) sendChunked(value)
      }
    } catch {
      // upstream read error: fall through to the close below
    }
    // The last chunk's seal() is still in flight at this point (sealing is async,
    // the read loop above is not) - closing before it lands truncates the final
    // bytes of any response that closes its connection right after writing.
    // sendChain itself is built so every link ends in its own .catch(), so it can
    // never reject; the .catch() here is defensive, not load-bearing.
    await sendChain.catch(() => {})
    ws.close()
  }

  async function handleFirstFrame(buf: Uint8Array): Promise<void> {
    const salt = buf.subarray(0, SALT_LEN)
    const keys = await deriveKeys(deps.key, salt)
    c2s = keys.c2s
    s2c = keys.s2c
    const init = decodeInit(await open(c2s, 0n, buf.subarray(SALT_LEN)))
    recvCtr = 1n

    // An empty cred is the single-tenant case. A cred that is present but
    // unparseable is a failed authentication, not a fall-through to direct.
    const cred = init.cred ? parseCred(init.cred) : null
    if (init.cred && !cred) throw new Error('unauthorized')
    const identity = await resolveIdentity(deps.store, cred)
    if (!identity) throw new Error('unauthorized')

    const dialed = await dial(identity.upstream, init.host, init.port, deps.connect)
    socket = dialed.socket
    // The client can vanish mid-dial, in which case onClose already ran while socket
    // was still undefined and nothing else would ever close the upstream.
    if (clientGone) {
      socket.close()
      return
    }
    writer = socket.writable.getWriter()

    sendCtr = 1n
    sendSealed(0n, new Uint8Array([STATUS_OK]))
    // Bytes the upstream handshake read past its own terminator belong to the
    // tunnel and must reach the client before anything else.
    if (dialed.leftover.length) sendChunked(dialed.leftover)
    void pumpUpstream(socket)

    if (identity.account) {
      const at = (deps.now?.() ?? new Date()).toISOString()
      void deps.store.touchAccount(identity.account.id, at).catch(() => {})
    }
  }

  async function handleMessage(data: ArrayBuffer | string): Promise<void> {
    if (typeof data === 'string') { ws.close(); return }
    const buf = new Uint8Array(data)
    try {
      if (!c2s) { await handleFirstFrame(buf); return }
      const pt = await open(c2s, recvCtr++, buf)
      // A frame can be chained behind a handshake that failed and closed; there is
      // no upstream to write to in that case.
      if (!writer) { ws.close(); return }
      await writer.write(pt)
    } catch {
      ws.close()
    }
  }

  let recvChain: Promise<void> = Promise.resolve()
  ws.onMessage((data) => { recvChain = recvChain.then(() => handleMessage(data)) })
  ws.onClose(() => {
    clientGone = true
    try { socket?.close() } catch { /* already gone */ }
  })
}
