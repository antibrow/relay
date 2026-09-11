import type { RelayWs } from '../core/types'

export function workersWs(ws: WebSocket): RelayWs {
  // Without this, binary frames arrive as Blob and the first frame is mis-read,
  // so the AEAD open fails. It only reproduces against a real deployment.
  ws.binaryType = 'arraybuffer'
  return {
    send: (data) => ws.send(data as ArrayBuffer | string),
    close: () => ws.close(),
    onMessage: (cb) => ws.addEventListener('message', (e) => cb(e.data as ArrayBuffer | string)),
    onClose: (cb) => ws.addEventListener('close', () => cb()),
  }
}
