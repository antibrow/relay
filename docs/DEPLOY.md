# Deploying antibrow-relay

This covers both runtimes this project supports: a Cloudflare Worker (backed
by a KV namespace) and a plain Node process (backed by a local SQLite file).
Every command below is meant to be copied as-is; replace `your.domain` and the
example credentials with your own.

## 1. Generate a key

```bash
npx antibrow-relay keygen
```

This prints a 32-byte pre-shared key, base64url-encoded. Save it somewhere
safe (a password manager, a secrets store) - it is not stored anywhere by the
relay itself.

This key is deployment-wide, not per-account. Every account you create shares
it for transport encryption; account identity is carried inside the encrypted
payload, not by the key. That means:

- Anyone who has the key can open a tunnel - an account credential is not
  required (see docs/PROTOCOL.md's Limits section: an omitted credential
  resolves to the relay's own direct egress, not a rejection).
- Losing the key (it leaks, or an operator who had it leaves) compromises the
  whole deployment, not one account. Rotate it.
- Rotating the key means updating every client that connects to this relay at
  the same time you update the server - there is no overlap window where both
  the old and new key work.

Set it as `FP_RELAY_KEY` wherever you deploy the relay (a Worker secret, an
`.env` file, or the process environment). Without it, the relay still starts
and the admin API still works, but every encrypted-protocol connection is
closed immediately.

## 2. Cloudflare Worker

```bash
npx wrangler kv namespace create RELAY_STORE
```

Copy the `id` this prints into the `[[kv_namespaces]]` block of `wrangler.toml`
(it ships with a placeholder value that must be replaced before the first
deploy).

```bash
npx wrangler secret put FP_RELAY_KEY
npx wrangler secret put ADMIN_KEY
npx wrangler deploy
```

`ADMIN_KEY` guards the `/admin` UI and the `/admin/accounts` and
`/admin/upstreams` APIs. Leave it unset and the entire admin surface answers
404, not 401 - an unauthenticated request cannot tell the admin API is even
there.

### What a Worker cannot dial

A Worker's `connect()` refuses to open a socket to an address Cloudflare
itself serves and reports it as an ordinary connection failure, so an account
on `direct` cannot reach a Cloudflare-fronted site from a Worker. Accounts
with an `http` or `socks5` upstream are unaffected: the socket goes to the
upstream proxy, which makes the outbound connection itself. If every account
on the deployment is meant to use `direct` egress, deploy on Node (step 4)
instead - Node has no such restriction.

## 3. Custom domain

Do this before pointing any real traffic at the deployment. It is the reason
to self-host at all.

The `workers.dev` subdomain Cloudflare assigns by default is blocked by
domain-category filtering on a meaningful fraction of networks, regardless of
which protocol runs over it - the block happens on the hostname, before a
single byte of the encrypted or plaintext protocol is inspected. A relay that
only answers on `*.workers.dev` will fail to connect from exactly the
networks self-hosting is meant to get you around.

In the Cloudflare dashboard, open the Worker's Settings > Domains & Routes and
bind a domain or subdomain you control. Once the DNS record and the binding
are both in place, use that domain everywhere below instead of the
`workers.dev` one - it is what makes this deployment worth running yourself
instead of pointing at someone else's hosted relay.

## 4. Node

```bash
npm install -g antibrow-relay
cp .env.example .env
# edit .env: set FP_RELAY_KEY, optionally ADMIN_KEY
node --env-file=.env "$(which antibrow-relay)" serve
```

Nothing in `antibrow-relay` itself reads a `.env` file - only Docker's
`env_file:` and the systemd unit's `EnvironmentFile=` load one automatically.
Running plain `antibrow-relay serve` after editing `.env` starts the relay
with none of those variables set, and it will silently print `encrypted
protocol: off (set FP_RELAY_KEY)` even though the key is sitting right there
in the file. `node --env-file=.env` is what actually loads it for a plain
Node run; without a `.env` file at all, exporting the variables in your shell
first works too.

`serve` reads `PORT` (default 8899), `DB_PATH` (default `./relay.db`), and the
same `FP_RELAY_KEY` / `ADMIN_KEY` / `ALLOW_PLAINTEXT` as the Worker. Only some
of these have a command line flag: `--port`, `--db`, and `--allow-plaintext`
exist on `serve` (run `antibrow-relay` with no arguments for the full list).
`FP_RELAY_KEY` and `ADMIN_KEY` are environment-only for `serve` - `probe` is
the one command that takes a key directly, as `--key`.

This needs Node 22.13.0 or newer (Node 24 included) - it uses the built-in
`node:sqlite` module. An older Node 22 build only has `node:sqlite` behind a
flag; if you are stuck on one, run `node --experimental-sqlite
$(which antibrow-relay) serve` instead. Upgrading Node is simpler than
carrying the flag around.

## 5. Docker

GitHub Actions publishes `ghcr.io/antibrow/relay` for Linux AMD64 and ARM64.
Pushes to `main` update `latest` and `main`; tags matching `v*` publish the
same image tag (for example, `v0.1.0`). Every build also gets a `sha-` tag.
You can run **Publish Docker image** manually from the Actions tab.
The workflow uses GitHub's built-in `GITHUB_TOKEN` with `packages: write`;
no registry secret is needed. After the first publication, set the package's
visibility to public in GitHub Packages to allow unauthenticated pulls.
Forks publish under `ghcr.io/<owner>/<repository>` automatically.

The Compose file uses `ghcr.io/antibrow/relay:latest` by default. To build
locally from source, replace that `image:` entry with `build: .` and run
`docker compose up -d --build`.

```bash
cp .env.example .env
# edit .env: set FP_RELAY_KEY, optionally ADMIN_KEY
# edit deploy/Caddyfile: replace relay.example.com with your domain
docker compose pull
docker compose up -d
```

The `relay` service runs the published GHCR image and keeps its
SQLite file in a named volume. The `caddy` service terminates TLS: the
AntiBrow kernel only ever connects over `wss://`, so something has to hold a
certificate, and Caddy gets one on its own the first time it sees a request
for the domain in the Caddyfile - no manual certificate step needed as long as
DNS already points at this host.

## 6. systemd

`deploy/relay.service` binds to `127.0.0.1` only (`--host 127.0.0.1` on its
`ExecStart`), not the `0.0.0.0` the relay binds to by default. The admin API
has no transport encryption of its own - the pre-shared key protects the
tunnel protocol, not `/admin` - so something has to terminate TLS in front of
it before it is reachable from outside this host, the same point section 5
makes for the Docker/Caddy setup. Put a reverse proxy (Caddy, nginx) in front
that terminates TLS and forwards to `127.0.0.1:8899`; do not remove `--host
127.0.0.1` from the unit to "expose it directly" - the AntiBrow kernel only
ever connects over `wss://` regardless, so a plain public bind buys nothing
and admin requests would cross it unencrypted.

The unit also runs as an unprivileged `relay` user with `ProtectSystem=strict`
and `StateDirectory=antibrow-relay`, so it can only write to
`/var/lib/antibrow-relay`, and systemd creates and owns that directory for you
- there is no manual `mkdir`/`chown` step for it. Set `DB_PATH` in
`/etc/antibrow-relay.env` to a file inside that directory, for example
`DB_PATH=/var/lib/antibrow-relay/relay.db`, before the first start: the
`.env.example` default of `/data/relay.db` is for the Docker image and is
outside this unit's `ReadWritePaths`, so leaving it in place fails the SQLite
file open.

Run this from inside a checkout of this repository:

```bash
npm install && npm run build && npm prune --omit=dev
sudo useradd --system --home /opt/antibrow-relay relay
sudo mkdir -p /opt/antibrow-relay
sudo cp -r dist node_modules /opt/antibrow-relay/
sudo chown -R relay:relay /opt/antibrow-relay
sudo cp deploy/relay.service /etc/systemd/system/
# create /etc/antibrow-relay.env with FP_RELAY_KEY, optionally ADMIN_KEY, and
# DB_PATH=/var/lib/antibrow-relay/relay.db
sudo systemctl enable --now relay
```

## 7. Create an account

Open `https://your.domain/admin` and enter the admin key, or use curl (these
assume `ADMIN_KEY` is exported in your shell; substitute the literal value
otherwise). Create the upstream first, then an account that points at it:

```bash
curl -X POST https://your.domain/admin/upstreams -H "x-admin-key: $ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"residential","protocol":"socks5","host":"gw.example","port":1080,"username":"u","password":"p"}'
curl -X POST https://your.domain/admin/accounts -H "x-admin-key: $ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"s3cret","upstreamId":"<id from above>"}'
```

`upstreamId` can also be the literal string `direct`, the built-in exit that
dials the target with no upstream proxy in front of it - useful for testing
without a residential proxy on hand.

### A note on how fast changes take effect

On the Worker deployment, account and upstream lookups are served through a
60-second Workers KV cache: resolving an account-based connection is two
cached reads, the account and then its upstream, while a credential-free
connection to a single-tenant relay needs neither. Every account-based
connection also updates that account's last-seen timestamp, which is two
further reads that do not use the cache - so an account-based connection is
four KV reads in total, two cached and two not. Disabling or renaming an account, or
editing the upstream it points at, can take up to a minute to be visible to
every edge location - not because anything is broken, but because that is the
consistency window the KV store gives a cached read. The Node deployment
reads SQLite directly on every request and has no such delay.

This is not a defect and it is not tunable per request. If a compromised
credential needs to be cut off with a hard guarantee rather than an
up-to-a-minute one, the only way to do that today is to rotate `FP_RELAY_KEY`
(`wrangler secret put FP_RELAY_KEY`, then update every other client) - which
revokes the whole deployment, not just the one account - or run this relay on
Node instead of the Worker. Otherwise, plan for the minute.

## 8. Verify

```bash
antibrow-relay probe wss://your.domain --key <key> --cred alice:s3cret
```

This opens a real tunnel through the relay - the same handshake a real client
performs - and fetches `https://ipinfo.io/json` through it by default
(pass `--url` to fetch something else). It prints the HTTP status and
body it got back. `probe` fails loudly rather than reporting success on a
response it could not fully read: a `Content-Length` the body falls short of
raises an error instead of printing a truncated line, so a clean exit and a
printed body both mean the tunnel really carried the whole response.

On a Worker, the target host matters for one reason that has nothing to do
with this protocol: `connect()` in a Worker refuses to open a socket to an
address Cloudflare itself serves, and it reports that as a connection failure,
not as a distinct error. An account on `direct` therefore cannot reach a
Cloudflare-fronted site from a Worker at all - which is why the default target
above is not one. An account with an `http` or `socks5` upstream is unaffected:
the socket goes to the upstream proxy, and the proxy makes the outbound
connection. A Node deployment has no such restriction.

A working deployment prints an IP address that belongs to the upstream
(`gw.example` in the example above, or your own residential/datacenter proxy)
- not the IP of the machine or Worker running the relay. If the account has no
upstream configured (`upstreamId: "direct"`), the printed IP is the relay's
own egress instead, which is still a valid result for `direct` but not proof
the upstream leg works.

## 9. Use it

This is SDK usage, not something to type into a desktop application's proxy
field - no desktop AntiBrow build reads a raw `relay://` string from its UI.

JavaScript:

```js
await launch({ proxy: 'relay://alice:s3cret@your.domain?key=<your key>' })
```

Python:

```python
launch(proxy='relay://alice:s3cret@your.domain?key=<your key>')
```

Either SDK hands the URL straight to the AntiBrow kernel's own `--proxy-server`
option, which understands the `relay` scheme natively with credentials
embedded in the URL. Swap in the username and password of any account created
in step 7, and the pre-shared key from step 1.

`?key=` is not optional in practice. It selects the encrypted protocol - both
for the browser and for the exit-IP lookup the SDK performs before launch, which
sets the browser's timezone and WebRTC identity from this relay's exit. Without
it the URL means the plaintext protocol of section 10, which this deployment
does not serve unless you turned it on; a malformed key is refused outright
rather than quietly downgraded.

## 10. Plaintext mode

Off by default. Turn it on with `ALLOW_PLAINTEXT=1` (an environment variable
for Node and Docker, a `[vars]` entry already present in `wrangler.toml` for
the Worker - only the literal string `1` turns it on, anything else, `true`
included, leaves it off).

The cost: plaintext mode puts the target hostname on the wire in clear text,
in the request path or headers, where anything watching the link between the
client and the relay can read it. The pre-shared key that protects the
encrypted protocol buys nothing here - plaintext connections do not use it at
all.

The reason it exists anyway: some operators would rather not manage a
pre-shared key at all for a low-stakes deployment, and some older or
third-party clients only speak the plaintext protocol and cannot be upgraded.
Turn it on only if one of those is actually true for your deployment.

## 11. Troubleshooting

**The WebSocket upgrade returns 404.** The request either did not carry an
`Upgrade: websocket` header, or the path was wrong. `/admin` and
`/admin/accounts` and `/admin/upstreams` are the only paths this relay
recognizes without an upgrade; everything else not carrying a valid plaintext
target answers 404 too.

**The upgrade succeeds and then the connection closes immediately.** No error
is ever sent back over the wire for this - closing silently is deliberate, so
that probing the endpoint from outside reveals nothing about why it failed.
Check, in order: `FP_RELAY_KEY` is actually set and is a valid 32-byte
base64url key (`antibrow-relay serve` prints a warning at startup if it is set
but unusable); the account username and password are correct; and, if you are
using the unencrypted protocol, that `ALLOW_PLAINTEXT=1` is actually set on
the relay you are connecting to.

**The tunnel opens but the target never connects.** This means the relay
reached your upstream proxy but the upstream refused to open the target
connection - wrong upstream username or password, or the upstream itself
rejecting the destination. Check the upstream's own credentials and logs, not
the relay's.

**On a Worker, one particular site always fails while everything else
works.** If the account is on `direct`, the site is almost certainly behind
Cloudflare: a Worker's `connect()` will not open a socket to an address
Cloudflare itself serves, and it surfaces as a plain connection failure with
nothing to distinguish it. Point the account at an `http` or `socks5`
upstream, or move the deployment to Node. See "What a Worker cannot dial" in
step 2.

**An account I just disabled or renamed still works.** See "A note on how
fast changes take effect" above - on the Worker deployment this can take up to
a minute. It is not a bug.
