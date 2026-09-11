import WebSocket from 'ws'
import { deriveKeys, keyFromBase64Url, open, seal, SALT_LEN } from '../src/protocol/crypto'
import { encodeInit } from '../src/protocol/frames'

/** A minimal fp-relay/1 client: exactly what the AntiBrow kernel does on the wire,
 *  without the browser. Frames are delivered in send order, not WebSocket arrival
 *  order: decryption runs on the threadpool and can finish out of order, so a
 *  promise chain re-serializes delivery the same way src/probe.ts does. */
export async function relayClient(
  url: string,
  keyB64: string,
  init: { host: string; port: number; cred?: string },
) {
  const psk = keyFromBase64Url(keyB64)
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN))
  const { c2s, s2c } = await deriveKeys(psk, salt)
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'

  const inbox: Uint8Array[] = []
  const waiters: { resolve: (v: Uint8Array) => void; reject: (e: Error) => void }[] = []
  let recvCtr = 0n
  let pendingError: Error | undefined
  let closedResolve: () => void
  const closed = new Promise<void>((r) => { closedResolve = r })

  let chain: Promise<void> = Promise.resolve()
  ws.on('message', (data) => {
    chain = chain.then(async () => {
      const pt = await open(s2c, recvCtr++, new Uint8Array(data as ArrayBuffer))
      const w = waiters.shift()
      if (w) w.resolve(pt)
      else inbox.push(pt)
    }).catch((e) => {
      const w = waiters.shift()
      if (w) w.reject(e as Error)
      else pendingError = e as Error
    })
  })
  // Rejecting pending waiters on close is what makes the "closes silently"
  // tests finish immediately instead of sitting out the timeout.
  ws.on('close', () => {
    closedResolve()
    while (waiters.length) waiters.shift()!.reject(new Error('relay closed the connection'))
  })
  ws.on('error', () => {})

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('close', () => reject(new Error('closed before open')))
    ws.once('error', reject)
  })

  let sendCtr = 1n
  // Same shape as the production send chain: counter allocation is synchronous,
  // sealing is not, so without this a Promise.all of sends could seal out of order.
  let sendChain: Promise<void> = Promise.resolve()
  function sendSealed(counter: bigint, plaintext: Uint8Array): Promise<void> {
    sendChain = sendChain.then(async () => {
      ws.send(await seal(c2s, counter, plaintext))
    })
    return sendChain
  }

  const sealedInit = await seal(c2s, 0n, encodeInit(init))
  const frame = new Uint8Array(SALT_LEN + sealedInit.length)
  frame.set(salt, 0)
  frame.set(sealedInit, SALT_LEN)
  ws.send(frame)

  const nextRaw = () =>
    new Promise<Uint8Array>((resolve, reject) => {
      if (pendingError) { const e = pendingError; pendingError = undefined; reject(e); return }
      const pending = inbox.shift()
      if (pending) { resolve(pending); return }
      // Kept below the vitest testTimeout on purpose: when a frame genuinely never
      // arrives, this message should fire first and name the real problem, instead
      // of the test just dying with a generic "Test timed out".
      const timer = setTimeout(() => reject(new Error('timed out waiting for a frame')), 15000)
      waiters.push({
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
    })

  const statusFrame = await nextRaw()
  return {
    status: statusFrame[0] ?? -1,
    async send(text: string) {
      await sendSealed(sendCtr++, new TextEncoder().encode(text))
    },
    next: async () => new TextDecoder().decode(await nextRaw()),
    closed,
    close: () => ws.close(),
  }
}
