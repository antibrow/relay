import { Duplex } from 'node:stream'
import tls from 'node:tls'
import WebSocket from 'ws'
import { SALT_LEN, deriveKeys, keyFromBase64Url, open, seal } from './protocol/crypto'
import { encodeInit } from './protocol/frames'

/**
 * Opens a real fp-relay/1 tunnel and performs one HTTP request through it. This
 * is the command that proves a fresh deployment works end to end: the tunnel
 * carries bytes, and the exit IP is the upstream's rather than the relay's.
 */
export async function probe(opts: {
  relayUrl: string
  key: string
  cred?: string
  targetUrl: string
}): Promise<{ status: number; body: string }> {
  const target = new URL(opts.targetUrl)
  const secure = target.protocol === 'https:'
  const port = Number(target.port) || (secure ? 443 : 80)

  const psk = keyFromBase64Url(opts.key)
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN))
  const { c2s, s2c } = await deriveKeys(psk, salt)

  const ws = new WebSocket(opts.relayUrl)
  ws.binaryType = 'arraybuffer'
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
    ws.once('close', () => reject(new Error('relay closed the connection before the tunnel opened')))
  })

  let sendCtr = 1n
  let recvCtr = 0n
  let gotStatus = false

  // A Duplex over the sealed frames, so node:tls can run on top of the tunnel.
  const tunnel = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, cb) {
      seal(c2s, sendCtr++, new Uint8Array(chunk)).then((f) => { ws.send(f); cb() }, cb)
    },
  })

  let chain: Promise<void> = Promise.resolve()
  ws.on('message', (data) => {
    chain = chain.then(async () => {
      const pt = await open(s2c, recvCtr++, new Uint8Array(data as ArrayBuffer))
      if (!gotStatus) {
        gotStatus = true
        if (pt[0] !== 0) throw new Error(`relay refused the tunnel, status ${pt[0]}`)
        return
      }
      tunnel.push(Buffer.from(pt))
    }).catch((e) => { tunnel.destroy(e as Error) })
  })
  // EOF has to queue behind the frames already being decrypted, or the last
  // chunk's plaintext is dropped and the response parses short.
  ws.on('close', () => {
    chain = chain.then(() => {
      tunnel.push(null)
    })
  })

  const initFrame = await seal(c2s, 0n, encodeInit({ host: target.hostname, port, cred: opts.cred }))
  const first = new Uint8Array(SALT_LEN + initFrame.length)
  first.set(salt, 0)
  first.set(initFrame, SALT_LEN)
  ws.send(first)

  const stream: Duplex = secure
    ? tls.connect({ socket: tunnel, servername: target.hostname })
    : tunnel
  if (secure) await new Promise<void>((r, j) => { stream.once('secureConnect', () => r()); stream.once('error', j) })

  stream.write(
    `GET ${target.pathname}${target.search} HTTP/1.1\r\n`
    + `Host: ${target.host}\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`,
  )

  const raw = await new Promise<string>((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error('timed out waiting for the target')), 15000)
    stream.on('data', (d: Buffer) => { out += d.toString('latin1') })
    stream.on('end', () => { clearTimeout(timer); resolve(out) })
    stream.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
  ws.close()

  const split = raw.indexOf('\r\n\r\n')
  const head = raw.slice(0, split)
  const status = Number(head.split('\r\n')[0]?.split(' ')[1] ?? 0)
  let body = raw.slice(split + 4)
  if (/transfer-encoding:\s*chunked/i.test(head)) {
    body = dechunk(body)
  } else {
    // "connection closed" is not "message complete": a declared Content-Length
    // that the body falls short of means the response was cut off, and a caller
    // trusting a 200 here would be trusting a false green.
    const declared = /content-length:\s*(\d+)/i.exec(head)?.[1]
    if (declared !== undefined && body.length !== Number(declared)) {
      throw new Error(`response truncated: content-length declared ${declared} bytes, got ${body.length}`)
    }
  }
  return { status, body }
}

function dechunk(input: string): string {
  let out = ''
  let rest = input
  for (;;) {
    const at = rest.indexOf('\r\n')
    if (at < 0) break
    const size = parseInt(rest.slice(0, at).split(';')[0] ?? '', 16)
    if (!Number.isFinite(size) || size === 0) break
    out += rest.slice(at + 2, at + 2 + size)
    rest = rest.slice(at + 2 + size + 2)
  }
  return out
}
