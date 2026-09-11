export type UpstreamProtocol = 'direct' | 'http' | 'socks5'

export interface Upstream {
  id: string
  name: string
  protocol: UpstreamProtocol
  host?: string
  port?: number
  username?: string
  password?: string
  note?: string
}

export interface Account {
  id: string
  username: string
  password: string
  upstreamId: string
  enabled: boolean
  note?: string
  createdAt: string
  lastSeenAt?: string
}

export interface RelayStore {
  // Returns accounts in ascending createdAt code-unit order, guaranteed across all implementations.
  listAccounts(): Promise<Account[]>
  getAccountByUsername(username: string): Promise<Account | null>
  putAccount(a: Account): Promise<void>
  deleteAccount(id: string): Promise<void>
  touchAccount(id: string, at: string): Promise<void>
  // Returns upstreams in ascending name code-unit order, guaranteed across all implementations.
  listUpstreams(): Promise<Upstream[]>
  getUpstream(id: string): Promise<Upstream | null>
  putUpstream(u: Upstream): Promise<void>
  deleteUpstream(id: string): Promise<void>
}

export const DIRECT_UPSTREAM: Upstream = { id: 'direct', name: 'direct', protocol: 'direct' }

export function newId(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 16)
}
