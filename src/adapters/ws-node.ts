import type { WebSocket } from 'ws'
import type { RelayWs } from '../core/types'

export function nodeWs(ws: WebSocket): RelayWs {
  ws.binaryType = 'arraybuffer'
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onMessage: (cb) => ws.on('message', (data) => cb(data as ArrayBuffer)),
    onClose: (cb) => ws.on('close', () => cb()),
  }
}
