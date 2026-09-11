# Relay

**Your own encrypted exit, on infrastructure nobody else administers.**

An encrypted relay protocol server. It runs unchanged as a Cloudflare Worker or as a plain Node process, and the AntiBrow kernel speaks to it natively through its `relay://` proxy option. Four reasons to run one:

**Nothing on the wire but sealed frames.** Both ends derive a pair of AES-256-GCM keys from your pre-shared key and a fresh per-connection salt, and every frame after that is sealed. The target hostname, the port and the account credential all travel inside the first sealed frame, so they are never written in clear text the way a `CONNECT` line or a SOCKS5 greeting writes them. What an observer between the client and the relay gets is one outbound WebSocket over TLS carrying binary frames.

**Cloudflare's network instead of the open internet.** On the Worker deployment the client's first hop is whichever Cloudflare edge location is closest to it, and the long leg to the relay runs over Cloudflare's own backbone rather than across the public internet to a single rented box in a single region. Every user gets a nearby entry point without you operating a server in their region.

**No bandwidth bill.** Cloudflare does not charge for bandwidth leaving a Worker, which is the entire reason this deploys there: the cost of relaying traffic is not measured in gigabytes. A personal deployment fits inside the free plan, and the Node build is there for when you would rather own the machine than the account.

**Yours, all of it.** You generate the pre-shared key and it never leaves your hands. You create the accounts, and you decide which upstream proxy each one exits through. There is no dashboard belonging to a vendor, no account to sign up for, no rate limit somebody else sets, and no third party in a position to read the traffic or to switch you off. MIT licensed, so forking it is a supported outcome.

## Quick start

```bash
npx antibrow-relay keygen
npx wrangler kv namespace create RELAY_STORE   # copy the id into wrangler.toml
npx wrangler secret put FP_RELAY_KEY
npx wrangler deploy
npx antibrow-relay probe wss://your.domain --key <key>
```

The full walkthrough - custom domains, Node, Docker, systemd, creating accounts, plaintext mode, and troubleshooting - is in [docs/DEPLOY.md](docs/DEPLOY.md).

## How it works

Past the handshake described above, the relay decrypts the first frame to read the target host, port and account credential, resolves the account to its upstream, and dials the target through it (directly, or through a configured HTTP or SOCKS5 proxy). From there it decrypts each frame from the client and writes the plaintext to that connection, sealing each byte it reads back before sending it on to the client - so the relay's encryption layer hides the target and the tunnel contents from anything between the client and the relay, but the relay itself sees whatever protocol the client is running inside the tunnel, same as any other proxy would. The full frame layout and key schedule are in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Clients

Anything that speaks the relay protocol can connect. Two clients ship today.

**The AntiBrow SDK** (JavaScript `anti-detect-browser`, Python `antibrow`) drives the AntiBrow kernel, which understands the `relay://` proxy scheme natively. Point a browser it launches at your relay with a single option - the username and password are an account you created (see [Accounts and upstreams](#accounts-and-upstreams)), and the host is your relay's own domain:

```js
// npm: anti-detect-browser
await launch({ proxy: 'relay://alice:s3cret@your.domain' })
```

```python
# PyPI: antibrow
launch(proxy='relay://alice:s3cret@your.domain')
```

The SDK hands that string straight to the kernel's `--proxy-server` option. It is SDK usage, not something to type into a desktop application's proxy field. Source, install and full documentation: https://github.com/antibrow/antibrow

**`antibrow-relay probe`**, built into this repo, implements the handshake in TypeScript and fetches one URL through the tunnel. It doubles as the reference client - the shortest complete example of the protocol, in [src/probe.ts](src/probe.ts) - and as the deployment smoke test:

```bash
antibrow-relay probe wss://your.domain --key <key> --cred alice:s3cret
```

Omit `--cred` for a single-tenant relay with no accounts; pass `--url` to fetch something other than the default.

## Accounts and upstreams

An account is a username/password pair that maps to an upstream (a proxy the relay dials through) or to `direct` (the relay's own egress, no proxy in front of it). Manage both through `/admin` (guarded by `ADMIN_KEY`) or its JSON API - see [docs/DEPLOY.md](docs/DEPLOY.md) for the exact requests. A single relay can host any number of accounts, each pointed at its own upstream, all sharing the one pre-shared key for transport encryption.

### One Cloudflare restriction on `direct`

A Worker's `connect()` refuses to open a socket to an address Cloudflare itself serves, and reports that as an ordinary connection failure rather than a distinct error. So an account on `direct` running on a Worker cannot reach a Cloudflare-fronted site at all. An account with an `http` or `socks5` upstream is unaffected - the socket goes to the upstream proxy, and the proxy makes the outbound connection - and a Node deployment has no such restriction. If a Worker deployment reaches most of the web but a handful of sites always fail, check this before anything else.

## Plaintext mode

Off by default, opt in with `ALLOW_PLAINTEXT=1`. It serves an older, unencrypted protocol alongside the encrypted one, which puts the target hostname on the wire in clear text - anything observing the link between the client and the relay can read it. Only turn it on if you specifically need to support a client that cannot speak the encrypted protocol. See [docs/DEPLOY.md](docs/DEPLOY.md#10-plaintext-mode) for the full trade-off.

## Development

```bash
npm test               # vitest, both runtimes' logic exercised through fakes
npx tsc --noEmit        # Node-facing types
npm run typecheck:worker  # Worker-facing types, against @cloudflare/workers-types
npx wrangler deploy --dry-run
```

This project pins `@cloudflare/workers-types` to `^4` on purpose, while the installed `wrangler` wants `^5`. That mismatch means `npm install` needs `--legacy-peer-deps` to resolve at all; `.npmrc` carries that setting so a fresh install works without anyone having to remember the flag, and so nobody deletes the file as unused cruft.

## License

MIT - see [LICENSE](LICENSE).
