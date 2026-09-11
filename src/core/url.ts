import type { Upstream } from './store'

type Parsed = Pick<Upstream, 'protocol' | 'host' | 'port' | 'username' | 'password'>

// Defaults must match the URL parser's own scheme defaults: a typed port equal
// to the default arrives blanked and is indistinguishable from an omitted one.
const SCHEMES: Record<string, { protocol: Upstream['protocol'], defaultPort: number }> = {
  http: { protocol: 'http', defaultPort: 80 },
  https: { protocol: 'http', defaultPort: 443 },
  socks: { protocol: 'socks5', defaultPort: 1080 },
  socks5: { protocol: 'socks5', defaultPort: 1080 },
  socks5h: { protocol: 'socks5', defaultPort: 1080 },
}

export function parseUpstreamUrl(raw: string): Parsed | null {
  let url: URL
  try {
    url = new URL(raw.trim())
    const scheme = SCHEMES[url.protocol.replace(/:$/, '').toLowerCase()]
    const host = url.hostname.replace(/^\[|\]$/g, '') // IPv6 arrives bracketed
    if (!scheme || !host) return null
    return {
      protocol: scheme.protocol,
      host,
      port: url.port ? Number(url.port) : scheme.defaultPort,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
    }
  } catch {
    return null
  }
}
