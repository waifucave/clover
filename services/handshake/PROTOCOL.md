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
| Join | `clover-handshake-v1 join`, `<group>`, `<new key>`, `<t>`, and `<from>` when the join moves the key out of another group | the joining device |
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
  | 4010 | reauth: the account token an account socket was opened with has ended; open a new one with a fresh token |

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
  - A device may remove itself alone. Removing another takes a quorum of the voters: see "Group recovery" below.
  - Removing the holder ends their lease.
  - When the last member goes, the group is deleted (410 afterwards).
- **Read:** `GET /v1/groups/<group>` (signed) answers `{"group", "members": [{"key", "joinedAt"}], "lease": {"holder": "<key>"|null, "epoch": 7, "expiresAt": …}}`.
- **Lease:** `POST /v1/groups/<group>/lease` (signed): `{"op": "acquire"|"renew"|"release"|"takeover", "epoch": 7, "ttl": 60}`.

  | `op` | Succeeds when | Then |
  | :- | :- | :- |
  | `acquire` | no holder, the lease expired, or the caller already holds it; in a group, a new tenure needs a voter (one exception for a tenure begun before that rule: "Group recovery") | the caller holds it; `epoch` rises by one unless the caller already held a live lease |
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

## Group recovery

Agreed with lane H (H-M1's review and the controller's rulings, November 6, 2026). Without it, any one member could remove every other member, admit keys of its own and take the lease, so a stolen device could lock the user's other devices out of their group. The thief gains no data that way, since each device's local revoke cuts its links at once (§8.1); what recovery protects is the user's shared lease.

- **Voters.** The founder votes from the start.
  - Any one member's admit lets a key in, a non-voter's too: a device paired through a recent one must get in.
  - A new key votes at once when the voters among its admitters are a quorum of the group's voters. Otherwise it votes 7 days after it joined, once the rollback window has passed: a key let in without a quorum never votes, or co-signs, while its admitter's changes can still be undone.
  - A group's recovery key, when it has one, is one more voter.
- **Quorum:** q = ⌊v/2⌋ + 1 of v voters. 403 `no_quorum` (with `voters` and `needed`) when the votes fall short. 403 `not_voter` when a co-signer doesn't vote.
- **Members** carry `votesFrom` (the vote starts at or before now) and `admittedBy`, in `GET /v1/groups/<group>`, the hello and `members` frames. Those also carry `recovery: true|false`.
- **Join with more admitters:** `POST …/members` may add `"admits": [{"by","sig"}]`, more admit statements over the same key and `t`, so the key votes at once.
- **A member's request:** the join may carry `"requester": {"key","sig"}`, the admit statement signed by the member that asked for the key. The requester counts among the change's signers, so the key is rolled back with it and left out of the vote on it, even when another member signed the admit. It never counts as a vote.
- **Moving from another of the user's groups:** the join may carry `"from": "<old group id>"`. Merges happen only inside a confirmed pairing, and the host's group survives.
  - The joining key signs `from` as the fifth line of its join statement, so no one else can ask for the move (401 otherwise).
  - **A vote never carries across groups.** The key votes in the host's group as any new key does: at once only when the host's voters admit it as a quorum, co-signed by their cards (a one-voter host is that quorum alone), and otherwise after 7 days. A thief's own group lends it nothing.
  - When the join adds the key (201), it leaves `from`: removed there as its own removal, with no rollback, its lease ended if it held it, the group ended if it was the last member, and a `members` frame sent. A join that adds nothing (the key was a member already) moves nothing.

  A `from` the key isn't a member of is an ordinary join. The client may still remove itself from the old group afterwards; a 404 or 410 there is fine.
- **Removing another member:** `DELETE /v1/groups/<group>/members/<key>`, signed by any member, with the body `{"t", "keep": [key…], "removes": [{"by","sig"}]}`.
  - The requester's own signed request is its vote when it votes. Each co-signer signs the remove statement:

    ```
    clover-handshake-v1 remove
    <group>
    <key>
    <t>
    <the kept keys, sorted, joined by ","; empty when none>
    ```

  - v counts the voters other than the target, and leaves out every key the target admitted in the last 7 days (and what those admitted), and every key admitted in the last 7 days without a quorum (not a voter yet). Those keys can't co-sign either (`not_voter`): otherwise a thief's keys, once they vote, would outvote the user.
  - `t` is within 10 minutes and after the target joined (409 `stale`). A lone removal by a voter needs no body, which is the usual two-device case.
  - **Removing yourself** needs only you, as before.
- **Rollback.** When others remove a member, the changes it signed in the last 7 days are undone:
  - The members it helped remove come back as they were (`joinedAt`, `votesFrom`), unless one is a member again or was removed since without it.
  - The keys it helped admit go, and so do the keys those admitted, except the ones the removal's `keep` lists. The requester is never dropped by its own removal.
  - So in its first week, a member can be removed by the keys it admitted only with the recovery code, or with voters it didn't admit. The founder of a two-device group without a code can't be removed by the other device until then.
  - The lease's `epoch` still only rises.
  - **The card:** `GET /v1/groups/<group>/rollback/<key>` (signed) answers `{"restores": [key…], "drops": [key…]}`, so the removal card lists what would go and the user can keep the keys they recognise.
- **The recovery code** (the owner's decision, for two-device account-less groups; lane H's client shows it when a second account-less device joins):
  - 128 random bits, shown as 26 Crockford base32 characters in groups of five (`XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-X`), read in any case, with 0/O and 1/I/L alike.
  - Its key is Ed25519 from seed = HKDF-SHA256(ikm = the code's 16 bytes, salt = the group id's 16 bytes, info = `clover handshake v1 recovery`, 32 bytes). `client/recovery.ts` has the format, the parser and the signer.
  - **Setting it:** `PUT /v1/groups/<group>/recovery`, signed by a member, `{"key": "<public key>"|null, "t", "sigs": [{"by","sig"}]}`, over

    ```
    clover-handshake-v1 recovery
    <group>
    <key, or empty to clear>
    <t>
    ```

    by a quorum of all the voters, the current recovery key included. When the second device has just joined, the founder alone is that quorum. `t` must be newer than the last change (409 `stale`), and the key can't be a member's (409 `conflict`). The service keeps only the public key, never the code.
  - **Using it:** the recovery key co-signs like a voter (`"by": "<its public key>"`). In a two-device group with a code, neither device alone can remove the other; the code and the surviving device can.
  - **Each use** pushes `{"t":"recovery","change":"admit"|"remove"|"recovery","target","by","at"}` to every member's socket, so the surviving device shows its card. For 7 days the last use is also in the group's view and in each hello as `recoveryUsed`, for a member that was offline.
- **The lease:** in a group, a member that doesn't vote yet never starts a tenure (403 `not_voter`), not by `takeover` and not by an `acquire` of a lease that is free: never held, released, lapsed, or freed by its holder's removal.
  - The founder votes from the start, so it takes the first lease alone.
  - Holding on (`acquire` while holding), `renew` and `release` need no vote.
  - **One exception, for tenures begun before this rule:** the lease's last holder may `acquire` its own released or lapsed lease again without a vote, while it is still a member. Under this rule every holder already voted when its tenure began, and a member's vote never lapses, so the exception only changes anything for a holder that took the lease, without a vote, before the rule was deployed. Any removal, self-removal or move-out clears the mark, so a key let back in never uses it.
  - The account channel's lease has no votes; the account list is its authority.
- **With an account,** the account's device list replaces the group (ruling R17), and the account service's revocation is the authority.

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
  - Claims: `iss`, `aud`, `sub` (the account), `dev` (the device), `iat` and `exp`. A token may live 5 minutes plus a minute's skew (`services/accounts` mints 5 minutes); a longer one is refused.
- **An account socket** lasts as long as the token it was opened with: its ticket carries the token's `exp`, and after it the socket closes with 4010, checked whenever the service next writes to it. So a device renews its socket every few minutes, with a fresh token. Revoking the device closes it at once.
- **A device may keep 64 records** (one per recipient and kind), and the account holds at most 512 queued messages over all its devices; the oldest go first.
- **A revoked device** is refused here for 16 minutes: the longest a token lasts (6 minutes with its skew), plus 10 minutes.
  - Its records, queued messages and socket go at once, and so does its lease.
  - This service keeps nothing else about it.

## Rendezvous: short pairing codes

A pairing by short code (lane H, `links/pairing.ts`) needs a place where the joiner finds the host before they share anything but the code. The code carries 40 bits that name a slot here and 80 bits of secret. The host puts its key and addresses in the slot, sealed under the secret, so this service can neither read them nor swap the host's key. None of these calls is signed, since the joiner has no key the service knows yet.

| Request | Body / answer |
| :- | :- |
| `PUT /v1/rendezvous/<slot>` | `{"box", "ttl", "token"}` → 201 `{"slot","expiresAt"}`; 200 with the same answer for a retry (the same token and box); 409 `taken` for anything else on a claimed slot |
| `GET /v1/rendezvous/<slot>` | → 200 `{"box","expiresAt"}`, or 404 `not_found` when there is none or it has ended |
| `DELETE /v1/rendezvous/<slot>` | `Authorization: Bearer <token>` → 204; 403 `forbidden` for another token; 404 when it's already gone |

- **`slot`:** the code's 5 bytes as base64url, 7 characters; a non-canonical one is 404.
- **`box`:** the host's offer, sealed by the client (lane H seals it as a pair box under a key from the code's secret, with the slot as its scope). At most 4096 bytes decoded.
- **`ttl`:** seconds, 1–600 (default 600). A pairing lasts 10 minutes.
- **`token`:** 16–32 random bytes as base64url, chosen by the host. The service keeps only its SHA-256, and only the token removes the slot early.
- **A slot is create-only.** Once claimed, its box never changes until the slot is removed or ends; not even its own token can replace it. So the box a joiner read is the one the host put, which lane H's pairing commits to. A retried `PUT` with the same token and box answers as the first did, ttl included. A host that gets 409 picks a new code. The service keeps nothing about a slot after it ends.
- **The client:** `HandshakeRendezvous` (`client/rendezvous.ts`) has the `publish`, `lookup` and `remove` lane H's pairing asks for, and keeps each slot's token in memory.

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
- `node` is optional, and lane H's link layer leaves it out: the peer already has the link key from its device registry.
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
`signal`: `type` is `offer`, `answer`, `candidate` or `end`. The web companion's one-time browser pairing uses the same kind for its own messages (`pair-request`, `pair-words`, `paired`, `pair-refused`; `services/web/protocol/pairing.ts`).

## Limits

- **Registration** (`POST /v1/pairs`, `POST /v1/groups`, `POST …/members`, and a rendezvous `PUT`) is limited hardest: 10 a minute per client address.
  - IPv6 addresses are grouped by /64. IPv4 counts per address, with room for carrier-grade NAT.
- **Everything else:** 120 requests a minute per member and scope (per device in the account channel), and signed requests 600 a minute per client address, counted before membership is known. A rendezvous `GET` or `DELETE` counts toward that same 600.
- **Each limit counts per Cloudflare location.**
- **Sizes:**
  - bodies up to 16 KiB, and boxes up to their kind's size
  - one record per sender and kind
  - 16 queued messages per recipient
  - 32 members per group
- **Retention:**
  - Records and messages are kept until their `ttl` at most, and so is a rendezvous slot.
  - A pair's or group's membership stays until it is ended or emptied; registrations never expire.
  - The lease and a member's last `t` stay with the membership.
  - Tombstones are kept 30 days, and a group's removed keys as long as the group.

## Cross-origin

The web companion (`https://clover.waifucave.com`) calls the service from the browser. The service answers CORS preflights for that origin alone (a list, `WEB_ORIGINS`, for local emulators), allowing `authorization` and `content-type`.
