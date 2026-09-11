// The whole runtime surface core/ is allowed to touch. Workers' connect() already
// has this shape; the Node adapter wraps net.Socket into it.
export interface RelaySocket {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  opened: Promise<void>
  close(): void
}

export interface RelayWs {
  send(data: Uint8Array | string): void
  close(): void
  onMessage(cb: (data: ArrayBuffer | string) => void): void
  onClose(cb: () => void): void
}

export type Connect = (host: string, port: number) => RelaySocket
