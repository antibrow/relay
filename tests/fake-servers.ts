import net from 'node:net'

const listen = (server: net.Server) =>
  new Promise<{ port: number; close(): void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo
      resolve({ port: addr.port, close: () => server.close() })
    })
  })

/** Upper-cases whatever it receives, so a test can prove bytes made the round trip. */
export function startEchoServer() {
  return listen(net.createServer((sock) => {
    sock.on('data', (d) => sock.write(Buffer.from(d.toString().toUpperCase())))
    sock.on('error', () => {})
  }))
}

export function startHttpProxy(
  opts: { requireAuth?: string; refuseWith?: number; piggyback?: string; delayMs?: number } = {},
) {
  return listen(net.createServer((sock) => {
    let head = ''
    let target: net.Socket | undefined
    sock.on('error', () => {})
    sock.on('data', (chunk) => {
      if (target) { target.write(chunk); return }
      head += chunk.toString('latin1')
      const end = head.indexOf('\r\n\r\n')
      if (end < 0) return
      const rest = Buffer.from(head.slice(end + 4), 'latin1')
      const lines = head.slice(0, end).split('\r\n')
      const auth = lines.find((l) => l.toLowerCase().startsWith('proxy-authorization:'))
      if (opts.refuseWith) {
        sock.end(`HTTP/1.1 ${opts.refuseWith} Refused\r\n\r\n`)
        return
      }
      if (opts.requireAuth) {
        const want = `Basic ${Buffer.from(opts.requireAuth).toString('base64')}`
        if (!auth || auth.slice(auth.indexOf(':') + 1).trim() !== want) {
          sock.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
          return
        }
      }
      const method = (lines[0] ?? '').split(' ')[0]
      const uri = (lines[0] ?? '').split(' ')[1]!
      // CONNECT carries a bare host:port. Any other method carries an absolute-form
      // URI (header mode forwards plain requests, not tunnels), which needs real
      // URL parsing rather than a naive split on ":".
      const isConnect = method === 'CONNECT'
      const [host, port] = isConnect ? uri.split(':') : (() => {
        const u = new URL(uri)
        return [u.hostname, u.port || '80']
      })()
      const requestHead = Buffer.from(head.slice(0, end + 4), 'latin1')
      target = net.connect(Number(port), host!, () => {
        const respond = () => {
          if (isConnect) {
            // piggyback exercises the case where the handshake reply and the first
            // tunnel bytes share one segment.
            sock.write(`HTTP/1.1 200 Connection Established\r\n\r\n${opts.piggyback ?? ''}`)
          } else {
            target!.write(requestHead)
          }
          if (rest.length) target!.write(rest)
        }
        // delayMs simulates a slow upstream handshake, to exercise the relay's
        // hold-until-dial-resolves behavior against a real elapsed delay.
        if (opts.delayMs) {
          setTimeout(respond, opts.delayMs)
        } else {
          respond()
        }
      })
      target.on('data', (d) => sock.write(d))
      target.on('error', () => sock.destroy())
      target.on('close', () => sock.end())
    })
  }))
}

/** Minimal RFC 1928 + RFC 1929 server, enough to exercise the client side.
 *  `atyp` controls which address family the reply claims, because the reply's
 *  length depends on it and getting that wrong eats tunnel bytes. */
export function startSocks5Proxy(
  opts: { requireAuth?: [string, string]; refuseWith?: number; atyp?: 1 | 3 | 4; piggyback?: string } = {},
) {
  return listen(net.createServer((sock) => {
    let phase: 'greet' | 'auth' | 'request' | 'tunnel' = 'greet'
    let buf = Buffer.alloc(0)
    let target: net.Socket | undefined
    sock.on('error', () => {})
    sock.on('data', (chunk) => {
      if (phase === 'tunnel') { target?.write(chunk); return }
      buf = Buffer.concat([buf, chunk])
      if (phase === 'greet') {
        if (buf.length < 2) return
        const n = buf[1]!
        if (buf.length < 2 + n) return
        const methods = [...buf.subarray(2, 2 + n)]
        buf = buf.subarray(2 + n)
        if (opts.requireAuth) {
          if (!methods.includes(2)) { sock.end(Buffer.from([5, 0xff])); return }
          sock.write(Buffer.from([5, 2]))
          phase = 'auth'
        } else {
          sock.write(Buffer.from([5, 0]))
          phase = 'request'
        }
      }
      if (phase === 'auth') {
        if (buf.length < 2) return
        const ulen = buf[1]!
        if (buf.length < 2 + ulen + 1) return
        const plen = buf[2 + ulen]!
        if (buf.length < 3 + ulen + plen) return
        const user = buf.subarray(2, 2 + ulen).toString()
        const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString()
        buf = buf.subarray(3 + ulen + plen)
        const [wu, wp] = opts.requireAuth!
        if (user !== wu || pass !== wp) { sock.end(Buffer.from([1, 1])); return }
        sock.write(Buffer.from([1, 0]))
        phase = 'request'
      }
      if (phase === 'request') {
        if (buf.length < 5) return
        const atyp = buf[3]!
        const alen = atyp === 1 ? 4 : atyp === 4 ? 16 : buf[4]! + 1
        if (buf.length < 4 + alen + 2) return
        const addr = atyp === 3
          ? buf.subarray(5, 4 + alen).toString()
          : [...buf.subarray(4, 4 + alen)].join('.')
        const port = buf.readUInt16BE(4 + alen)
        buf = buf.subarray(6 + alen)
        if (opts.refuseWith) { sock.end(Buffer.from([5, opts.refuseWith, 0, 1, 0, 0, 0, 0, 0, 0])); return }
        const replyAtyp = opts.atyp ?? 1
        const reply = replyAtyp === 1
          ? Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80])
          : replyAtyp === 4
            ? Buffer.concat([Buffer.from([5, 0, 0, 4]), Buffer.alloc(16), Buffer.from([0, 80])])
            : Buffer.concat([Buffer.from([5, 0, 0, 3, 9]), Buffer.from('localhost'), Buffer.from([0, 80])])
        target = net.connect(port, addr, () => {
          sock.write(Buffer.concat([reply, Buffer.from(opts.piggyback ?? '')]))
          if (buf.length) target!.write(buf)
          phase = 'tunnel'
        })
        target.on('data', (d) => sock.write(d))
        target.on('error', () => sock.destroy())
        target.on('close', () => sock.end())
      }
    })
  }))
}

/** Origin server that can answer either framing, and records the request line
 *  and headers it saw so a test can assert what we actually sent.
 *  keepAlive skips the closing sock.end(), for tests that need to prove the
 *  *client* side closes the socket rather than relying on the origin to do it. */
export function startOriginServer(
  opts: { chunked?: boolean; body?: string; keepAlive?: boolean; extraHeaders?: string[] } = {},
) {
  let last = ''
  const body = opts.body ?? 'hello'
  const extra = (opts.extraHeaders ?? []).map((h) => `${h}\r\n`).join('')
  const server = net.createServer((sock) => {
    let raw = ''
    let headEnd = -1
    let wantLength = 0
    sock.on('error', () => {})
    sock.on('data', (chunk) => {
      raw += chunk.toString('latin1')
      if (headEnd < 0) {
        headEnd = raw.indexOf('\r\n\r\n')
        if (headEnd < 0) return
        const m = /content-length:\s*(\d+)/i.exec(raw.slice(0, headEnd))
        wantLength = m ? Number(m[1]) : 0
      }
      // A client that writes headers and body as separate socket writes (this
      // relay does) can have them land in separate TCP reads, so the request
      // is not complete just because the header terminator showed up.
      if (raw.length < headEnd + 4 + wantLength) return
      last = raw
      if (opts.chunked) {
        const mid = Math.ceil(body.length / 2)
        sock.write(
          `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\n${extra}\r\n`
          + `${mid.toString(16)}\r\n${body.slice(0, mid)}\r\n`
          + `${(body.length - mid).toString(16)}\r\n${body.slice(mid)}\r\n0\r\n\r\n`,
        )
      } else {
        sock.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nContent-Type: text/plain\r\n${extra}\r\n${body}`)
      }
      if (!opts.keepAlive) sock.end()
    })
  })
  return listen(server).then((h) => ({ ...h, lastRequest: () => last }))
}
