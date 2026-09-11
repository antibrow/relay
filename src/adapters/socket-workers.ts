import { connect } from 'cloudflare:sockets'
import type { Connect } from '../core/types'

export const workersConnect: Connect = (hostname, port) => {
  const socket = connect({ hostname, port })
  // Mirrors socket-node.ts: a late failure surfaced only through this promise,
  // with nothing awaiting it, would otherwise be an unhandled rejection instead
  // of reaching the caller through the readable/writable streams.
  socket.closed.catch(() => {})
  return {
    readable: socket.readable,
    writable: socket.writable,
    // connect() resolves lazily. Awaiting opened turns a refused connection into
    // a rejection here instead of an opaque "WritableStream closed" much later.
    opened: socket.opened.then(() => undefined),
    close: () => { void socket.close() },
  }
}
