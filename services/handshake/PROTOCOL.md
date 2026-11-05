# The waifucave handshake, wire format v1

`handshake.waifucave.com` introduces devices to each other. It carries each device's addresses, a "dial now", and the browser's WebRTC signalling, and it holds the main computer's lease: in the account for devices with one, and in a group for devices paired without one (spec §8.3, §6.4; owner decisions 81 and 85; the controller's rulings on account-less pairs, November 5, 2026).

This file is the contract between the service (lane I, `services/handshake/`) and its clients: the daemon's link layer (lane H) and the web companion (lane I). Change it only together.

## Principles

- **Signalling only.** It never carries a link's traffic. Records and messages are end-to-end encrypted between the devices, so the service sees only opaque boxes, their sizes and their timing.
- **Current state only.** It keeps the latest record of each kind, queued messages for at most two minutes, the members of each pair and group, and the lease. It keeps no history, no IP log, no names and no addresses in the clear.
- **No account needed.** A pair or a group is its own authority: its members' keys sign every request. Devices with an account use the account channel instead (below), with the same records, messages, sockets and lease.

## Scopes

| Scope | Who is in it | How a request proves it | Path prefix |
| :- | :- | :- | :- |
| **Pair** | The two devices of one pairing | an Ed25519 signature by a member's pair key | `/v1/pairs/<pair>` |
| **Group** | One user's account-less devices (for the lease) | an Ed25519 signature by a member's group key | `/v1/groups/<group>` |
| **Account** | The devices of one waifucave account | the device's account token (`aud`: `handshake.waifucave.com`) | `/v1/accounts/self` |

- `<pair>` and `<group>` are 16 random bytes, chosen by the devices when they pair, as unpadded base64url (22 characters).
- **Keys are Ed25519 public keys** (32 bytes, base64url).
  - The service knows members only by these keys.
  - Lane H chooses whether they are fresh per pair or group (recommended: then the service can't link a device's pairs to its link key or its other pairs) or the device's link key.
  - Either way, every signature below starts with its own `clover-handshake-v1 …` prefix, so it can't be mistaken for any other use of the key.
- **A pair belongs to no group at the service.** A group exists only for the lease; devices join it when they pair (the controller's ruling: one group per user for their account-less devices).

## Encoding

- **Bodies are JSON** (`content-type: application/json`), at most 16 KiB. Binary fields are unpadded base64url; a key is 32 bytes and a signature 64.
- **Times are milliseconds since the epoch.** Durations are given in seconds (`ttl`).
- **Errors** are `{"error": "<code>"}` with these statuses:

  | Status | Codes |
  | :- | :- |
  | 400 | `bad_request`, `bad_kind`, `bad_signature_form` |
  | 401 | `unauthorized`: a bad signature or token, or `t` out of range; `replay`: `t` not after the key's last (retry with a fresh `t`) |
  | 403 | `not_member`, `revoked` |
  | 404 | `not_found` |
  | 409 | `conflict`, `stale`, `full`, `held` (with the current lease) |
  | 410 | `ended`: a revoked pair or a deleted group |
  | 413 | `too_large` |
  | 429 | `rate_limited`, with `retry-after` in seconds |

## Statements: proving a key at registration

Registration requests carry statements signed with Ed25519. Each statement is UTF-8 lines joined by `\n`, with no trailing newline, and its `t` must be within 10 minutes of the service's clock.

| Statement | Lines | Signed by |
| :- | :- | :- |
| Pair | `clover-handshake-v1 pair`, `<pair>`, `<key A>`, `<key B>`, `<t>` | both A and B, the same text |
| Group | `clover-handshake-v1 group`, `<group>`, `<key>`, `<t>` | the founding member |
| Join | `clover-handshake-v1 join`, `<group>`, `<new key>`, `<t>` | the joining device |
| Admit | `clover-handshake-v1 admit`, `<group>`, `<new key>`, `<t>` | a current member |

The keys in a pair statement are in the order the request lists them. `<t>` is written in decimal.

## Signed requests (pair and group scopes)

Every other pair or group request carries one header:

```
Authorization: Clover-Sig key=<member key>, t=<ms>, sig=<signature>
```

`sig` is the Ed25519 signature, by `key`, over:

```
clover-handshake-v1 request
<METHOD>
<path, with its query if any>
<t>
<base64url of SHA-256 of the body bytes; of zero bytes when there is no body>
```

The service accepts it when all of these hold:
- `key` is a current member of the scope the path names.
- `t` is within 120 s of its clock.
- **For every request but a plain GET,** `t` is greater than the last `t` it accepted from that key in that scope. The client sends `t = max(now, last t + 1)`, and one such request at a time per scope, since a later one that arrives first makes the earlier a `replay`. This is the replay protection; it costs the service one stored number per member.
- **A plain GET** may repeat within the 120 s. It returns only ciphertext the caller is entitled to, so a replay learns nothing new.

## Pairs

- **Register:** `POST /v1/pairs`, with no Authorization header:

  ```json
  {"pair": "<pair>", "keys": ["<A>", "<B>"], "t": 1793000000000, "sigs": ["<sig by A>", "<sig by B>"]}
  ```

  | Status | When |
  | :- | :- |
  | 201 | a new pair |
  | 200 | the same pair and the same two keys again (idempotent) |
  | 409 `conflict` | the pair id is held by other keys |
  | 410 `ended` | the pair was revoked |

  This is rate-limited hardest (see Limits).
- **Read:** `GET /v1/pairs/<pair>` (signed). Answers:

  ```json
  {"pair": "<pair>", "keys": ["<A>", "<B>"], "peer": {"online": true},
   "records": [{"from": "<key>", "kind": "addr", "gen": 1793000000123, "expiresAt": 1793000900123, "box": "<box>"}]}
  ```

  `records` holds the peer's records that haven't expired.
- **End:** `DELETE /v1/pairs/<pair>` (signed, by either member) → 204.
  - After §8.1's local revoke, the revoking device ends the pair here.
  - The service forgets the keys, records and messages, closes both sockets (4003), and keeps only a tombstone (the pair id and when it ended) for 30 days, answering 410.

### Records: the latest of each kind

`PUT /v1/pairs/<pair>/records/<kind>` (signed):

```json
{"gen": 1793000000123, "ttl": 900, "box": "<box>"}
```

- Answers 204, or 409 `stale` when `gen` isn't greater than the sender's current record of that kind. Use the time in ms as `gen`.
- The record replaces the sender's previous one, is pushed to the peer's socket, and is forgotten at `ttl`.

### Messages: delivered once, gone in two minutes

`POST /v1/pairs/<pair>/messages` (signed):

```json
{"kind": "dial", "ttl": 30, "box": "<box>"}
```

- Answers 202 `{"id": "<id>", "delivered": true|false}`.
- `delivered: true` means it went straight to the peer's open socket, and nothing is kept.
- Otherwise it is queued for the peer: at most 16 per recipient (the oldest is dropped first), each until its `ttl`.

`POST /v1/pairs/<pair>/inbox` (signed, empty body) answers `{"messages": [{"id", "from", "kind", "at", "expiresAt", "box"}]}` and removes them.

### The socket: pushes instead of polling

1. `POST /v1/pairs/<pair>/tickets` (signed) answers `{"url": "wss://…/v1/socket?ticket=…", "expiresAt": …}`. The ticket is single-use, lasts 60 s and is bound to the member. Browsers can't sign a WebSocket upgrade, hence the ticket.
2. Open a WebSocket to `url`. A member has one socket per scope: a new one replaces the old, which closes with 4000.

Service → client (text, JSON):

| Frame | When |
| :- | :- |
| `{"t":"hello","v":1,"scope":"pair","peer":{"online":bool}}` | first, then the queued messages and the peer's current records |
| `{"t":"record","from","kind","gen","expiresAt","box"}` | the peer published a record |
| `{"t":"message","id","from","kind","at","expiresAt","box"}` | a message for this member (delivered: not kept) |
| `{"t":"presence","online":bool}` | the peer's socket opened or closed |
| `{"t":"bye","reason":"replaced"\|"ended"\|"stale"\|"reauth"}` | then the close |

- **Client → service:** only `"ping"`, answered `"pong"` by the runtime without waking the service. Send one every 30 s. Mutations always go over HTTPS, signed.
- **Close codes:**

  | Code | Meaning |
  | :- | :- |
  | 4000 | replaced |
  | 4003 | ended or revoked |
  | 4008 | protocol |
  | 4009 | stale: no ping for 90 s |
  | 4010 | reauth: an account socket's 24 hours are up; open a new one with a fresh token |

- **Presence** means the member has an open socket that pinged within 90 s. Treat it as a hint: a `dial` waits 30 s in the queue anyway.

### Kinds

| Kind | Sent as | Most `ttl` (default) | Most box size | What it carries |
| :- | :- | :- | :- | :- |
| `addr` | record | 3600 s (900) | 4 KiB | the sender's addresses for this peer |
| `dial` | message | 60 s (30) | 4 KiB | "dial me now" (both devices dial at once, and again about 100 ms later; S1) |
| `signal` | message | 120 s (60) | 8 KiB | WebRTC signalling for a browser link |

A box's size is its decoded bytes. Other kinds are refused with 400 `bad_kind`; a later version adds them.

## Groups and the lease (account-less devices)

The lease decides which computer is the main one (spec §6.4). For account-less devices the service holds it in their group, so "the first computer to take it wins" holds across all of one user's devices.

- **Create:** `POST /v1/groups`, not signed: `{"group", "key", "t", "sig"}` (the group statement). Answers 201, 200 when the founder is already a member, 409 `conflict` when the group exists without them, or 410 for a deleted group.
- **Join:** `POST /v1/groups/<group>/members`, not signed: `{"key", "t", "sig", "by", "bysig"}`.
  - `sig` is the new device's join statement, and `bysig` the admit statement of `by`, a current member.
  - Answers 201, or 200 if it's already a member. At most 32 members (409 `full`).
  - A removed key may rejoin only with statements signed after its removal (403 `revoked` otherwise), so an old join can't be replayed.
- **Remove:** `DELETE /v1/groups/<group>/members/<key>` (signed by any member) → 204.
  - A device may remove itself or another (a revocation).
  - Removing the holder ends their lease.
  - When the last member goes, the group is deleted (410 afterwards).
- **Read:** `GET /v1/groups/<group>` (signed) answers `{"group", "members": [{"key", "joinedAt"}], "lease": {"holder": "<key>"|null, "epoch": 7, "expiresAt": …}}`.
- **Lease:** `POST /v1/groups/<group>/lease` (signed): `{"op": "acquire"|"renew"|"release"|"takeover", "epoch": 7, "ttl": 60}`.

  | `op` | Succeeds when | Then |
  | :- | :- | :- |
  | `acquire` | no holder, the lease expired, or the caller already holds it | the caller holds it; `epoch` rises by one unless the caller already held a live lease |
  | `renew` | the caller holds it and `epoch` matches | `expiresAt` moves on |
  | `release` | the caller holds it and `epoch` matches | no holder (the next acquire raises `epoch`) |
  | `takeover` | always: the user chose this computer (§6.4) | the caller holds it, and `epoch` rises by one |

  - `ttl` is 10–300 s (default 60).
  - Answers 200 `{"lease": …}`, or 409 `{"error": "held", "lease": …}`.
  - **`epoch` is the fencing token.** It only ever rises. The main computer stamps its acts with it, and peers refuse acts with an epoch older than the newest they have seen (lane H, H-M2).
  - Only computers take the lease; phones and browsers read it.
- **The socket:** `POST /v1/groups/<group>/tickets` (signed), then the WebSocket as for pairs.
  - The hello is `{"t":"hello","v":1,"scope":"group","lease":…}`.
  - Every change pushes `{"t":"lease","lease":…}` and every membership change `{"t":"members","members":[…]}`.

## The account channel (devices with an account)

The same records, messages, socket and lease, for the devices of one account. The sender is the token's `dev`; records and messages are addressed to a device, and the lease's holder is a device id:

| Request | Body / answer |
| :- | :- |
| `PUT /v1/accounts/self/records/<kind>/<to device>` | `{"gen","ttl","box"}` → 204 / 409 `stale` |
| `GET /v1/accounts/self` | `{"online":["<device id>"],"records":[…addressed to the caller…],"lease":…}`; `online` lists the account's other devices with a live socket |
| `POST /v1/accounts/self/messages` | `{"to","kind","ttl","box"}` → 202 `{"id","delivered"}` |
| `POST /v1/accounts/self/inbox` | `{"messages":[…]}` |
| `POST /v1/accounts/self/lease` | as for groups → 200 `{"lease"}` / 409 `held` |
| `DELETE /v1/accounts/self/devices/<device>` | 204: after a revoke at the account service, any device of the account tells this service too |
| `POST /v1/accounts/self/tickets` | `{"url","expiresAt"}`, then the socket |

- **Account frames:**
  - The hello is `{"t":"hello","v":1,"scope":"account","online":[…],"lease":…}`, `online` again without the caller.
  - `record` and `message` frames carry `from` as a device id.
  - `presence` frames carry the device: `{"t":"presence","device","online"}`.
  - `lease` frames as for groups.
- **The token:** `Authorization: Bearer <account token>`.
  - ES256 or EdDSA, checked against the account service's JWKS, as the forwarder and push check it.
  - Claims: `iss`, `aud`, `sub` (the account), `dev` (the device), `iat` and `exp`, lasting at most 24 hours.
- **An account socket** lasts up to 24 hours, then closes with 4010 (checked whenever the service next writes to it); revoking the device closes it at once.
- **A device may keep 64 records** (one per recipient and kind), and the account holds at most 512 queued messages over all its devices; the oldest go first.
- **A revoked device** is refused here for 24 hours and 10 minutes (the longest a token lasts, plus skew).
  - Its records, queued messages and socket go at once, and so does its lease.
  - This service keeps nothing else about it.

## Boxes: the client-side encryption

The service never opens a box. Both clients must seal them alike:

- **Pair scope.**
  - Pairing gives both devices a 32-byte pair secret S (lane H derives it from the pairing handshake; it never reaches the service).
  - The key: K = HKDF-SHA256(ikm = S, salt = the pair id's 16 bytes, info = `clover handshake v1 box`, 32 bytes).
  - The box: base64url of `nonce (12 random bytes) || AES-256-GCM(K, nonce, plaintext, aad)`.
- **Account scope.**
  - HPKE base mode, single shot, with DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and AES-256-GCM: the forwarder's suite.
  - It is sealed to the recipient device's X25519 key from the account's device list, with info `clover handshake v1 box`.
  - The box: base64url of `enc (32) || ciphertext`.
  - This needs every account device to list an X25519 key (lane H).
- **`aad`** is UTF-8 lines joined by `\n`: `clover-handshake-v1 box`, the scope id (`<pair>`, or the account's `sub`), the sender key or device id, the recipient key or device id, the kind, and for a record its `gen`.

  A box moved to another pair, another direction, another kind or another generation fails to open.

Plaintexts are UTF-8 JSON. Unknown fields are ignored, and `at` (ms) lets the receiver drop stale ones:

```json
{"v": 1, "at": 1793000000123, "lan": ["192.168.1.20:41642"], "stun": ["203.0.113.7:41642"], "mapped": [],
 "mapping": "same", "relay": "https://euw1-1.relay.iroh.network./", "node": "<link key or iroh node id>"}
```
`addr`: lane H owns these fields.
- `stun` is asked from the port the link then binds (S1).
- `mapping` is `same` when two STUN servers saw the same address, `varies` behind a symmetric NAT, or `unknown`.

```json
{"v": 1, "at": 1793000000123, "addr": { … an addr plaintext, optional … }}
```
`dial`: the receiver dials the sender at once, and again about 100 ms later.

```json
{"v": 1, "at": 1793000000123, "session": "<id>", "type": "offer", "sdp": "v=0…"}
{"v": 1, "at": 1793000000123, "session": "<id>", "type": "candidate", "candidate": {"candidate": "…", "sdpMid": "0", "sdpMLineIndex": 0}}
```
`signal`: `type` is `offer`, `answer`, `candidate` or `end`.

## Limits

- **Registration** (`POST /v1/pairs`, `POST /v1/groups`, `POST …/members`) is limited hardest: 10 a minute per client address.
  - IPv6 addresses are grouped by /64. IPv4 counts per address, with room for carrier-grade NAT.
- **Everything else:** 120 requests a minute per member and scope (per device in the account channel), and signed requests 600 a minute per client address, counted before membership is known.
- **Each limit counts per Cloudflare location.**
- **Sizes:**
  - bodies up to 16 KiB, and boxes up to their kind's size
  - one record per sender and kind
  - 16 queued messages per recipient
  - 32 members per group
- **Retention:**
  - Records and messages are kept until their `ttl` at most.
  - A pair's or group's membership stays until it is ended or emptied; registrations never expire.
  - The lease and a member's last `t` stay with the membership.
  - Tombstones are kept 30 days, and a group's removed keys as long as the group.

## Cross-origin

The web companion (`https://clover.waifucave.com`) calls the service from the browser. The service answers CORS preflights for that origin alone (a list, `WEB_ORIGINS`, for local emulators), allowing `authorization` and `content-type`.
