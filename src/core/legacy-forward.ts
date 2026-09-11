import { ByteReader } from './bytes'
import { buildRequestBytes, readUpstreamResponse } from './legacy-response'
import type { Upstream } from './store'
import type { Connect, RelaySocket } from './types'
import { dial } from './upstream'

/**
 * Plaintext header mode: the relay performs the request itself for plain-http
 * targets. https targets go through the tunnel instead, because there is no TLS
 * client on this path - a raw socket cannot be upgraded once it is inside a
 * CONNECT tunnel.
 */
export async function forwardHttp(
  req: Request,
  target: URL,
  upstream: Upstream,
  connect: Connect,
): Promise<Response> {
  if (target.protocol !== 'http:') {
    return new Response('https targets must use the tunnel path, not header mode\n', { status: 400 })
  }

  // An http upstream is a proxy: talk to it in absolute form and let it connect.
  // socks5 and direct put us on the origin socket, so origin form is correct there.
  const proxyMode = upstream.protocol === 'http'
  const port = Number(target.port) || 80

  let socket: RelaySocket | undefined
  let reader: ByteReader | undefined
  try {
    let leftover: Uint8Array = new Uint8Array(0)
    if (proxyMode) {
      if (!upstream.host || !upstream.port) throw new Error('upstream is missing host or port')
      socket = connect(upstream.host, upstream.port)
      await socket.opened
    } else {
      const dialed = await dial(upstream, target.hostname, port, connect)
      socket = dialed.socket
      leftover = dialed.leftover
    }

    const writer = socket.writable.getWriter()
    try {
      await writer.write(buildRequestBytes({
        method: req.method,
        target,
        headers: req.headers,
        absoluteForm: proxyMode,
        upstreamAuth: proxyMode && upstream.username ? `${upstream.username}:${upstream.password ?? ''}` : undefined,
      }))
      if (req.body) {
        const bodyReader = req.body.getReader()
        for (;;) {
          const { value, done } = await bodyReader.read()
          if (done) break
          if (value) await writer.write(value)
        }
      }
    } finally {
      writer.releaseLock()
    }

    reader = new ByteReader(socket.readable)
    if (leftover.length) reader.unshift(leftover)
    // readUpstreamResponse only throws before it hands the reader off to a body
    // stream, never after: the body streams (chunked/fixed) release it themselves
    // once they are the ones driving it, so releasing here on catch cannot race them.
    const res = await readUpstreamResponse(reader)
    return new Response(closeWhenDone(res.body, socket), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  } catch {
    reader?.release()
    socket?.close()
    return new Response('upstream request failed\n', { status: 502 })
  }
}

/** The returned Response streams from a socket the caller cannot reach, so the body
 *  is the only place left that knows when the upstream is finished with.
 *  A caller that neither reads nor cancels the body leaves the socket open forever -
 *  a lazy stream has no other signal, both entry points onto this function always
 *  consume or cancel what they get, and a timeout would be guarding against a caller
 *  nobody has asked for. */
function closeWhenDone(body: ReadableStream<Uint8Array>, socket: RelaySocket): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  const shut = () => {
    try {
      socket.close()
    } catch { /* already gone */ }
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read()
        if (done) {
          controller.close()
          shut()
          return
        }
        if (value) controller.enqueue(value)
      } catch (e) {
        controller.error(e)
        shut()
      }
    },
    cancel(reason) {
      void reader.cancel(reason)
      shut()
    },
  })
}
