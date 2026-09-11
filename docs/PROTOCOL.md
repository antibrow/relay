# The fp-relay/1 protocol

This document describes the wire protocol implemented by this repository:
what goes on the wire, why each piece is shaped the way it is, and what the
protocol does not protect against. It is written to be enough, on its own
plus the source files it cites, to write an interoperable client or server.
It is not a deployment guide - see DEPLOY.md for that - and it is not a
sales pitch. Section 9 in particular is written to be read as carefully as
the rest.

Every source reference below points at a file in this repository. Where this
document and the code disagree, the code is correct and this document has a
bug.

## Threat model

There are three parties who can observe something about a connection, and
this section says exactly what each of them sees.

1. A passive observer on the network path between the client and the relay
   (an ISP, a transit network, anyone with a packet capture on that link).
   On the encrypted path this observer sees a single outbound WebSocket
   connection over TLS to the relay's own host, opened once and held open,
   carrying a stream of opaque binary frames of varying length. They do not
   see the target host or port, the account credential, or any bytes of the
   tunneled protocol. They see connection timing and frame sizes, both of
   which are discussed under Limits.

2. A managed device running TLS interception (a corporate root certificate
   installed for deep packet inspection). This device terminates the
   client's TLS session and can read what is underneath it: the WebSocket
   upgrade request, its headers, and the plaintext bytes of every relay
   frame - salt, ciphertext, and authentication tag. It cannot read what is
   inside those frames without the pre-shared key, so it still cannot
   recover the target host, the account credential, or the tunneled traffic.
   It can, however, see that a WebSocket connection carrying binary frames
   of relay-frame shape exists, which is more than the first observer gets.
   This is spelled out again under Limits: such a device is not looking at
   an invisible connection.

3. The destination the tunneled traffic is ultimately headed to (the target
   web site, or the exit side of whatever HTTP or SOCKS5 upstream the
   account is configured to dial through). This party sees exactly what it
   would see from any other proxy: the source IP of the upstream (or of the
   relay itself, in direct mode), and the plaintext application traffic the
   tunnel carries, since the relay decrypts each frame before writing it to
   the upstream socket (`src/core/session.ts`, `handleMessage`). The relay
   protects the link between the client and itself; it does not encrypt
   anything past the point where it dials out.

## Why not SOCKS5 over TLS

A SOCKS5 connection has a fixed, small vocabulary of handshake bytes: a
greeting, a method selection, a connect request with a fixed-format address
field. Wrapping that exchange in TLS hides its bytes from a passive network
observer, but it does not change what is on the wire once TLS is peeled
back, and it does nothing at all against observer 2 above - a device doing
TLS interception sees the SOCKS5 handshake exactly as if there were no TLS,
because the handshake bytes themselves are the signature. A fixed-length,
fixed-structure protocol header is exactly what heuristic and DPI matching
for proxy protocols looks for, independent of which transport carries it.

The first frame of `fp-relay/1` is not that. It is a 32-byte salt followed
by an AEAD ciphertext whose length depends on the target hostname's length,
the account credential's length, and the AEAD's fixed 16-byte tag - see
Frame format below. There is no shared fixed-length prefix across
connections to a given relay: every connection's first frame is a different
length because every account credential and every target hostname are
different lengths. There is nothing here to write a signature against,
whether or not the WebSocket carrying it happens to be wrapped in TLS.

## Frame format

This section plus Key schedule below are meant to be sufficient to write an
interoperable implementation, matching `src/protocol/frames.ts` and
`src/protocol/crypto.ts` byte for byte.

### Init frame

The Init frame describes the target the client wants the relay to dial, and
carries the account credential. All multi-byte integers are big-endian.

```
field     width      notes
-----     -----      -----
ver       u8         protocol version, currently 1 (INIT_VER)
hostLen   u8         length of host, 0-255
host      hostLen    target hostname, UTF-8, not length-prefixed beyond hostLen
port      u16be      target port
credLen   u16be      length of cred, 0-65535
cred      credLen    account credential, UTF-8, opaque at this layer
```

An empty `cred` (credLen 0) selects the relay's single-tenant, unauthenticated
identity, which dials `direct` (`src/core/store.ts`, `DIRECT_UPSTREAM`;
`src/core/session.ts`, the `init.cred ?` branch). A non-empty `cred` that
does not parse as `username:password` (split on the first colon, so
passwords may contain colons - `src/core/auth.ts`, `parseCred`) is treated
as a failed authentication, not as a fall-through to the unauthenticated
identity.

### First frame on the wire

The very first WebSocket message the client sends is not the Init frame by
itself. It is:

```
salt(32 bytes, raw)  ||  seal(c2s, counter=0, encodeInit(...))
```

`salt` is 32 random bytes chosen fresh per connection by the client
(`SALT_LEN` in `src/protocol/crypto.ts`) and is the salt input to the key
schedule described in the next section. `seal` is the AEAD sealing operation
defined there, applied to the encoded Init frame under counter 0 of the
client-to-server key. The relay reads the first 32 bytes of the first
message as the salt, derives both direction keys from it, and opens the
remainder as counter 0 of `c2s` (`src/core/session.ts`, `handleFirstFrame`).

### Success reply

If the relay accepts the connection - the Init frame decodes, the
credential (if any) resolves to an enabled account or is empty, and the
upstream dial succeeds - it replies with exactly one sealed byte:

```
seal(s2c, counter=0, [0x00])
```

`0x00` is `STATUS_OK` (`src/protocol/frames.ts`). Values `0x01` through
`0xFF` are reserved for future status codes and this implementation never
sends any of them. There is no failure status: every failure path closes
the WebSocket without sending any reply at all (see Threat model and
Limits - this is deliberate, not an oversight, and it means an implementer
must not expect a rejection frame to ever arrive).

After the success reply, any bytes the upstream handshake itself read past
its own terminator (see Upstream dialling) are sent immediately after,
chunked the same way ordinary tunnel data is (see Nonces and ordering), and
then ordinary tunnel data follows in both directions: each WebSocket message
after the first is one AEAD-sealed frame, `open`ed or `seal`ed under the
next counter value for its direction, carrying a chunk of the tunneled
protocol's raw bytes.

### Plaintext size limit

A single frame's plaintext is capped at 16384 bytes (`MAX_PLAINTEXT` in
`src/protocol/crypto.ts`). Data larger than that is split into consecutive
frames on the same direction's counter (`src/core/session.ts`,
`sendChunked`); there is no framing marker for where one logical write ends
and the next begins; the tunneled protocol is a raw byte stream, and this
splitting is invisible to it.

## Key schedule

Both sides derive two independent AES-256-GCM keys from a shared 32-byte
pre-shared key (`PSK_LEN` in `src/protocol/crypto.ts`) and the per-connection
salt described above, using HKDF-SHA256:

```
c2s_key = HKDF-SHA256(ikm = PSK, salt = <32-byte client salt>, info = "fp-relay/1 c2s")
s2c_key = HKDF-SHA256(ikm = PSK, salt = <32-byte client salt>, info = "fp-relay/1 s2c")
```

Each derived key is 32 bytes, used directly as an AES-256-GCM key
(`src/protocol/crypto.ts`, `deriveKeys`). Every AEAD seal and open operation
additionally uses a fixed, connection-independent associated data value:

```
AAD = "fp-relay/1"
```

The three ASCII strings above - `fp-relay/1 c2s`, `fp-relay/1 s2c`, and
`fp-relay/1` - are cryptographic inputs to HKDF and to the AEAD, not
descriptive labels. They are part of the wire format in the same sense the
frame layout is: changing a single byte in any of them yields an
implementation that derives different keys, or authenticates different
associated data, from the same pre-shared key and salt, and therefore
cannot interoperate with any implementation that has not made the identical
change. There is no version negotiation for these strings; the leading
`fp-relay/1` in each is the version marker, and a future incompatible
revision of this protocol would define new strings, not reuse these ones
with different behavior behind them.

## Nonces and ordering

Each direction has its own monotonically increasing 64-bit counter, starting
at 0 for the first frame sealed or opened in that direction (the Init frame
occupies counter 0 of `c2s`; the success reply occupies counter 0 of `s2c`).
The 12-byte AES-GCM nonce for a given counter value is:

```
nonce = 0x00000000 || uint64be(counter)
```

four zero bytes followed by the counter as an 8-byte big-endian integer
(`src/protocol/crypto.ts`, `nonce`).

This is a requirement on any implementation of either side, not a stylistic
choice made by this codebase: AES-GCM's security depends on never reusing a
(key, nonce) pair, and the nonce here is derived solely from the counter.
If two frames in the same direction are ever sealed or opened out of counter
order - for example because a server implementation processes messages from
its receive queue concurrently instead of one at a time - the nonces used
for encryption and decryption stop matching between the two sides, and every
frame after the first mismatch fails to authenticate. There is no recovery
from this within a connection: the AEAD state cannot resynchronize, and the
connection is unusable for the rest of its life. An implementation must
therefore serialize the handling of both directions against themselves: the
next inbound frame must not be opened until the previous one has been fully
handled (including, for the very first frame, completing the upstream dial
that frame triggers - see `src/core/session.ts` for the promise-chain
construction that guarantees this on both the send and receive sides), and
outbound frames must be written to the wire in the order their counter
values were allocated, even though the sealing operation that produces their
ciphertext is itself asynchronous.

## Upstream dialling

Once the relay has resolved an Init frame's credential to an account (or to
the unauthenticated `direct` identity), it dials the target through that
account's configured upstream (`src/core/upstream.ts`, `dial`). There are
three modes:

- **direct**: the relay opens a TCP connection straight to the target host
  and port. This is the relay's own network egress.
- **HTTP CONNECT**: the relay opens a TCP connection to the configured
  upstream host and port, sends `CONNECT host:port HTTP/1.1` (with a
  `Proxy-Authorization: Basic` header if the upstream has a username), and
  reads the response status line. Any non-2xx status fails the dial.
- **SOCKS5**: the relay speaks the SOCKS5 handshake to the configured
  upstream: a method greeting (offering both no-auth and username/password
  when the upstream has credentials, so an upstream that accepts no-auth
  even though it was configured with a password is not treated as an
  error), an optional username/password sub-negotiation, and a connect
  request.

The SOCKS5 connect request addresses the target by domain name (ATYP 3),
not by an IP address the relay resolved itself. This is deliberate: if the
relay resolved the hostname locally and sent the resulting IP address, DNS
resolution would happen from the relay's network location while the traffic
exits from the upstream's network location, and those two can disagree
(different registrar/geo results, or a target that resolves differently
per region). Sending the domain name lets the upstream - the exit whose IP
the target will actually see - do its own DNS resolution, keeping the two
consistent.

In both the HTTP CONNECT and SOCKS5 cases, the relay reads the handshake
response from the same TCP stream the tunneled traffic will use, and it is
possible for the upstream to have already sent bytes belonging to the
tunneled protocol in the same packet as the end of its handshake response
(for example, a SOCKS5 server that pipelines the connect reply with the
first bytes of the target's response). Any such bytes read past the
handshake's own terminator are tunnel data, not handshake data, and must be
delivered to the client before anything else the relay reads from that
socket afterward - dropping them produces a client that appears to hang
partway through a TLS handshake, having silently lost its ServerHello. This
repository's `DialResult.leftover` (`src/core/upstream.ts`) exists
specifically to carry those bytes forward; both the encrypted session
(`src/core/session.ts`) and the plaintext tunnel (`src/core/legacy-tunnel.ts`)
send it immediately after their respective success signal and before
starting their normal upstream-to-client pump.

## Traffic analysis

What a passive observer on the network path actually sees, on the encrypted
path, is an ordinary `wss://` WebSocket connection to whatever host the
operator has put the relay behind - commonly a CDN edge in front of a
Cloudflare Worker, or a plain TLS-terminating reverse proxy in front of a
Node process. Specifically, there is no cleartext HTTP CONNECT line, no
SOCKS5 handshake bytes, no fixed-length protocol header of any kind (see
Frame format and Why not SOCKS5 over TLS above), and the TLS ClientHello's
SNI names the operator's own domain rather than any third party or any
name recognizable as belonging to a proxy service. Signature and heuristic
matching that looks for the wire-level shape of a proxy or anonymizer
protocol - the kind built into enterprise firewalls and DPI appliances -
has nothing of that shape to match here, because the connection is, at the
level such matching operates, a WebSocket connection like any other.

That is the extent of the claim this section makes. It is not a claim that
any specific product, or any class of product, fails to detect or block
this traffic by other means - by domain reputation, by TLS fingerprinting
of the client library, by behavioral analysis of connection timing or
volume, or by any other signal not discussed above. Those are separate
questions from wire-format signature matching, and this protocol does not
address them; see Limits.

## Plaintext mode

`fp-relay/1` is the only protocol this relay encrypts. Alongside it, the
relay can optionally serve an older, unencrypted protocol on the same
WebSocket and HTTP endpoints, gated behind `ALLOW_PLAINTEXT=1` (the literal
character `1`; any other value, including unset, leaves it off -
`src/core/router.ts`, `buildRelayEnv`). It exists for two reasons: to
support clients that predate the pre-shared-key protocol and cannot be
upgraded, and to let an operator run the relay without managing a
pre-shared key at all, at the cost described below.

Plaintext mode has two entry points, both requiring HTTP Basic
`Proxy-Authorization` against an account (there is no unauthenticated
direct identity on this path - `src/core/auth.ts`, `requireIdentity`):

- A WebSocket tunnel, selected by a `?host=&port=` query string on the
  upgrade request. The relay dials the target the same way as the
  encrypted path (see Upstream dialling), sends the literal string `READY`
  once the upstream connection is open, then relays raw bytes both ways
  with no framing and no encryption (`src/core/legacy-tunnel.ts`).
- An HTTP forwarding mode for plain-`http://` targets, where the relay
  itself makes the request and streams the response back
  (`src/core/legacy-forward.ts`). `https://` targets are rejected on this
  path and must use the WebSocket tunnel instead, because there is no TLS
  client on the header-forwarding path - a raw upstream socket cannot be
  handed a TLS layer once the relay itself has already spoken HTTP on it.

What plaintext mode gives up: the target hostname and port travel in clear
text, in the WebSocket query string or in the request itself, visible to
anyone who can observe the link between the client and the relay - the same
link that the encrypted path's Init frame keeps opaque. The account
credential also travels as an HTTP Basic header, base64-encoded but not
encrypted. None of the properties described in Threat model or Traffic
analysis above hold on this path: the WebSocket URL alone gives a passive
observer the destination host and port.

This is why it is off unless an operator turns it on deliberately, and why
turning it on is a whole-deployment decision rather than a per-account one:
enabling it exposes every account's tunneled destinations to the same
observer the encrypted path is designed to keep them from.

## Limits

This section exists so nothing above is read as a stronger guarantee than
the code provides. Every point here is a real limit of the current design,
not a hedge.

- **No forward secrecy.** The pre-shared key does not ratchet or rotate
  itself; every connection derives its keys from the same long-lived PSK
  and a fresh salt, and that salt travels on the wire in cleartext as the
  first 32 bytes of the first message (see Frame format). Anyone who
  recorded a connection's frames and later obtains the PSK - because it
  leaked, or because an operator who held it is compromised - can derive
  that connection's keys from the recorded salt and decrypt everything in
  the capture, including traffic recorded long before the key was
  obtained. There is no mechanism in this protocol that limits the blast
  radius of a key compromise to traffic seen after the compromise.

- **The key is per deployment, not per account.** One pre-shared key
  encrypts the transport for every account on a given relay instance.
  There is no way to revoke transport-layer access for a single account
  without rotating the key for the entire deployment, which requires
  updating every other client at the same time (see DEPLOY.md). Disabling
  an account (`Account.enabled`) stops it from resolving to an upstream,
  but it does not and cannot stop a party who already has the key and that
  account's credential from being able to construct a validly-encrypted
  Init frame - the disabled holder does not need the relay to act on their
  credential, because they can simply stop sending it (see the next point).

- **On the encrypted path, an account credential is optional, not a gate.**
  `resolveIdentity` (`src/core/auth.ts`) treats an absent credential as the
  single-tenant case and resolves it to the relay's own direct egress -
  the same exit a `direct` upstream would give an authenticated account.
  So on a multi-account relay, any holder of the deployment-wide key can
  send a zero-length credential instead of their assigned one and reach
  that direct egress: no account lookup happens, `Account.enabled` is
  never consulted, and no `lastSeenAt` is recorded. This is deliberate -
  it is what lets a single-tenant relay work with no accounts configured
  at all - but it means accounts are a routing and accounting mechanism,
  not an access-control boundary. The pre-shared key is the only access
  control this protocol has.

- **A managed device doing TLS inspection is not looking at an invisible
  connection.** As described under Threat model, such a device sees the
  WebSocket upgrade request and every relay frame's plaintext bytes -
  salt, ciphertext, and tag. It cannot decrypt what is inside those frames
  without the pre-shared key, and there is no fixed-length protocol
  signature to match (see Traffic analysis). But it is not blind: it can
  see that a WebSocket carrying binary frames of this shape exists, at
  this URL, at this time. Anything that acts on that alone - rather than
  on decrypting or signature-matching the payload - is not defeated by
  this protocol.

- **Domain category filtering is unaffected by any of this.** A network
  policy that blocks traffic by the reputation or category of the domain
  name in the SNI or in DNS sees the operator's own relay domain, not the
  final target's domain, and reacts to whatever category that domain falls
  into - which is exactly why an operator is told to put the relay behind
  a domain they control rather than a shared or free hosting subdomain
  (see DEPLOY.md). Nothing about the encryption, framing, or key schedule
  changes how domain-category filtering behaves.

- **Timing and traffic volume correlation are not defended against.** An
  observer who can see both ends of a connection - the client's link to
  the relay and the relay's or upstream's link to the target - and who
  correlates connection timing or traffic volume (frame sizes, or total
  bytes transferred) between the two can link them, the same way this
  works against any proxy or VPN. This protocol makes no attempt at
  padding, timing obfuscation, or traffic shaping to resist that kind of
  analysis.

- **Account passwords are stored in plaintext.** `Account.password`
  (`src/core/store.ts`) is compared with a constant-time equality check
  (`src/core/auth.ts`, `constantTimeEqual`) rather than a timing-unsafe
  one, but it is not hashed - the stored value is the password itself, in
  both the SQLite and KV store adapters. Anyone with read access to the
  operator's own database or KV namespace reads every account's password
  directly. This is a property of running your own relay: the operator's
  storage is not a separate trust boundary from the operator.
