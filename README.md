# Relay

**One endpoint, many accounts, each exiting through a different proxy.**

Relay is the indirection layer between the browsers you automate and the proxies you actually pay for. You point every AntiBrow profile at one hostname you own, and the relay decides which upstream each of them leaves through, per account, on the server side. It runs unchanged as a Cloudflare Worker or as a plain Node process, and the AntiBrow kernel speaks to it natively through its `relay://` proxy option. Four reasons to run one:

**Accounts are the unit; upstreams are the pool.** An upstream is a proxy the relay dials through (`http`, `socks5`, or the built-in `direct`, which is the relay's own egress). An account is a username/password pair bound to exactly one upstream. Profiles hold accounts, never proxy endpoints - so a profile's identity is stable while the exit behind it is yours to move. Repoint an account at a different upstream and the next connection leaves through the new exit, with nothing changed on any client.

**Your provider credentials stay on the relay.** The proxy host, port, username and password live in the relay's store, write-only through the admin API - a `GET` masks them. What a client holds is an account you minted, and what it reaches is your domain. Nothing that runs on a workstation, in a container, or in a teammate's script ever carries the credential your proxy bill is attached to. Disable an account and it stops resolving immediately; delete an upstream and the relay refuses while accounts still reference it, naming them.

**Nothing on the wire but sealed frames.** Both ends derive a pair of AES-256-GCM keys from your pre-shared key and a fresh per-connection salt, and every frame after that is sealed. The target hostname, the port and the account credential all travel inside the first sealed frame, so they are never written in clear text the way a `CONNECT` line or a SOCKS5 greeting writes them. What an observer between the client and the relay gets is one outbound WebSocket over TLS carrying binary frames - identical for every account, whatever each one exits through.

**Cloudflare's network, and no bandwidth bill.** On the Worker deployment a client's first hop is whichever Cloudflare edge location is closest to it, and the long leg runs over Cloudflare's backbone rather than the public internet to a single rented box. Cloudflare does not charge for bandwidth leaving a Worker, so the cost of fronting a whole proxy pool is not measured in gigabytes, and a personal deployment fits inside the free plan. The Node build is there for when you would rather own the machine than the account.

All of it is yours. You generate the pre-shared key and it never leaves your hands. There is no vendor dashboard, no signup, no rate limit somebody else sets, and no third party in a position to read the traffic or to switch you off. MIT licensed, so forking it is a supported outcome.

## Quick start

```bash
npx antibrow-relay keygen
npx wrangler kv namespace create RELAY_STORE   # copy the id into wrangler.toml
npx wrangler secret put FP_RELAY_KEY
npx wrangler secret put ADMIN_KEY
npx wrangler deploy
npx antibrow-relay probe wss://your.domain --key <key>
```

That much gives you a working single-tenant relay on its own egress. Open `/admin` to add the upstreams and accounts. The full walkthrough - custom domains, Node, Docker, systemd, plaintext mode, and troubleshooting - is in [docs/DEPLOY.md](docs/DEPLOY.md).

## Accounts and upstreams

An upstream is a row: a name, a protocol (`direct`, `http` or `socks5`), and for the proxied protocols a host, a port and optional credentials. `direct` is built in and has no row of its own. An account is a username, a password, the id of the upstream it exits through, and an `enabled` flag; the relay stamps `lastSeenAt` on every connection it authenticates, so an idle account is visible as one.

Manage both through `/admin` (guarded by `ADMIN_KEY`) or the same JSON API it is built on - `GET`/`POST`/`DELETE` on `/admin/accounts` and `/admin/upstreams`, authenticated with an `x-admin-key` header. Exact requests are in [docs/DEPLOY.md](docs/DEPLOY.md). A single relay hosts any number of accounts, each pointed at its own upstream, all sharing the one pre-shared key for transport encryption - so onboarding a client is minting an account, not distributing a proxy.

A connection with no credential at all resolves to `direct`, which is what makes the quick start above useful before any account exists. Once accounts matter, note that this is a fall-through and not an authentication bypass: a credential that is present but wrong, or names a disabled account, is rejected rather than downgraded to `direct`.

### One Cloudflare restriction on `direct`

A Worker's `connect()` refuses to open a socket to an address Cloudflare itself serves, and reports that as an ordinary connection failure rather than a distinct error. So an account on `direct` running on a Worker cannot reach a Cloudflare-fronted site at all. An account with an `http` or `socks5` upstream is unaffected - the socket goes to the upstream proxy, and the proxy makes the outbound connection - and a Node deployment has no such restriction. If a Worker deployment reaches most of the web but a handful of sites always fail, check this before anything else.

## How it works

Past the handshake described above, the relay decrypts the first frame to read the target host, port and account credential, resolves the account to its upstream, and dials the target through it. From there it decrypts each frame from the client and writes the plaintext to that connection, sealing each byte it reads back before sending it on to the client - so the relay's encryption layer hides the target and the tunnel contents from anything between the client and the relay, but the relay itself sees whatever protocol the client is running inside the tunnel, same as any other proxy would. SOCKS5 upstreams are handed the hostname rather than a resolved address, so DNS happens at the exit and the resolver's location agrees with the exit IP. The full frame layout and key schedule are in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Clients

Anything that speaks the relay protocol can connect. Two clients ship today.

**The AntiBrow SDK** (JavaScript `anti-detect-browser`, Python `antibrow`) drives the AntiBrow kernel, which understands the `relay://` proxy scheme natively. Point a browser it launches at your relay with a single option - the username and password are an account you created, and the host is your relay's own domain:

```js
// npm: anti-detect-browser
await launch({ proxy: 'relay://alice:s3cret@your.domain?key=<your key>' })
```

```python
# PyPI: antibrow
launch(proxy='relay://alice:s3cret@your.domain?key=<your key>')
```

Swapping which exit a profile uses is swapping the username in that string, or leaving the string alone and repointing the account in `/admin`.

`?key=` is the pre-shared key from `keygen`, and it is what selects the encrypted protocol - for the browser itself and for the exit-IP lookup the SDK runs before launch, so the browser's timezone and WebRTC identity follow the exit that account resolves to. Leave it out and the URL asks for the older plaintext protocol, which this relay only serves with `ALLOW_PLAINTEXT=1`; a malformed key is refused rather than downgraded. The SDK hands the string straight to the kernel's `--proxy-server` option. It is SDK usage, not something to type into a desktop application's proxy field. Source, install and full documentation: https://github.com/antibrow/antibrow

**`antibrow-relay probe`**, built into this repo, implements the handshake in TypeScript and fetches one URL through the tunnel. It doubles as the reference client - the shortest complete example of the protocol, in [src/probe.ts](src/probe.ts) - and as the way to check that an account really exits where you think it does:

```bash
antibrow-relay probe wss://your.domain --key <key> --cred alice:s3cret
```

Omit `--cred` to exercise the relay's own egress; pass `--url` to fetch something other than the default.

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
