#!/usr/bin/env node
import { randomKeyBase64Url } from './protocol/crypto'
import { startNodeRelay } from './node'
import { probe } from './probe'

const USAGE = `antibrow-relay <command>

  keygen                              print a fresh 32-byte pre-shared key
  serve [options]                     run the relay
    --port <n>          listen port (default 8899, or PORT)
    --host <addr>       bind address (default 0.0.0.0)
    --db <path>         sqlite file (default ./relay.db, or DB_PATH)
    --allow-plaintext   also serve the unencrypted protocol (off by default)
  probe <relay-url> [options]         open a real tunnel and fetch a url
    --key <base64url>   pre-shared key (default FP_RELAY_KEY)
    --cred <user:pass>  relay account, omitted for a single-tenant relay
    --url <url>         target (default https://ipinfo.io/json)

Environment: FP_RELAY_KEY, ADMIN_KEY, ALLOW_PLAINTEXT, PORT, DB_PATH
`

function flag(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : undefined
}

const argv = process.argv.slice(2)
const command = argv[0]

if (command === 'keygen') {
  console.log(randomKeyBase64Url())
} else if (command === 'serve') {
  const key = process.env.FP_RELAY_KEY
  const adminKey = process.env.ADMIN_KEY
  const allowPlaintext = argv.includes('--allow-plaintext') || process.env.ALLOW_PLAINTEXT === '1'
  const server = await startNodeRelay({
    port: Number(flag(argv, 'port') ?? process.env.PORT ?? 8899),
    host: flag(argv, 'host'),
    dbPath: flag(argv, 'db') ?? process.env.DB_PATH ?? './relay.db',
    key,
    adminKey,
    allowPlaintext,
  })
  console.log(`relay listening on :${server.port}`)
  // A key that is set but unusable must not read as ordinary "off" status -
  // the operator is watching this output and needs to know it is their typo.
  if (key && !server.keyAccepted) {
    console.log(`  WARNING: FP_RELAY_KEY is set but could not be used - it must be a 32-byte key, base64url-encoded ('antibrow-relay keygen' produces one)`)
  }
  console.log(`  encrypted protocol: ${server.keyAccepted ? 'on' : 'off (set FP_RELAY_KEY)'}`)
  console.log(`  plaintext protocol: ${allowPlaintext ? 'ON - target hostnames travel in clear text' : 'off'}`)
  console.log(`  admin: ${adminKey ? '/admin' : 'off (set ADMIN_KEY)'}`)
} else if (command === 'probe') {
  const relayUrl = argv[1]
  const key = flag(argv, 'key') ?? process.env.FP_RELAY_KEY
  if (!relayUrl || !key) {
    console.error('probe needs a relay url and a key (--key or FP_RELAY_KEY)')
    process.exit(2)
  }
  const out = await probe({
    relayUrl,
    key,
    cred: flag(argv, 'cred'),
    targetUrl: flag(argv, 'url') ?? 'https://ipinfo.io/json',
  })
  console.log(`HTTP ${out.status}`)
  console.log(out.body.trim())
} else {
  console.log(USAGE)
  process.exit(command ? 2 : 0)
}
