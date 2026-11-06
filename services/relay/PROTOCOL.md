# The Cloudflare relay, wire format v1

The relay a user runs in their own Cloudflare account (spec §8.3: "No iroh relay exists for Cloudflare yet, so that one is a relay we write"). It carries a link's traffic between two of the user's devices when no direct path works, and keeps sealed sync mail for a device that is never online at the same time as the sender (`RelayHandler.putMail`).

The relay never sees content: a link's frames are end-to-end encrypted by the link layer (lane H), and mail is sealed for its device before it reaches the relay plugin. What the relay sees is which devices talk, when, and how much.

The `clover/relay-cloudflare` plugin is its client: it hands the link layer the room URL, and keeps mail.

## Who may use it

The user deploys the Worker with one secret, `RELAY_KEY`: at least 32 random bytes, base64url. Their devices hold the same key as the relay plugin's secret (`relay-key`), so the core adds it to the plugin's requests and plugin code never reads it (the keyed fetch, spec §5.4).

- **API requests** carry `Authorization: Bearer <RELAY_KEY>`.
- **Room sockets** carry a ticket instead, since the link layer is handed a URL, and browsers can't set headers on a WebSocket.
- **Revoking a device** means rotating `RELAY_KEY` (§8.1's guided rotation): every ticket made with the old key stops working at once.

Errors are `{"error": "<code>"}`: 400 `bad_request`, 401 `unauthorized`, 404 `not_found`, 409 `full`, 413 `too_large`, 426 `upgrade_required`, 429 `rate_limited`.

## Rooms: carrying a link

1. `POST /v1/tickets` (Bearer) answers `{"url": "wss://<relay>/v1/rooms?ticket=<ticket>", "expiresAt": <ms>}`.
   - The ticket lasts 24 hours and opens any room; the plugin hands this URL to the link layer as a `websocket` endpoint.
   - A refused upgrade (401) means the ticket expired or the key was rotated: ask the plugin for its endpoints again.
2. The link layer opens a WebSocket to that URL with `&room=<room>&peer=<peer>` added.
   - `room`: 16–64 characters of `[A-Za-z0-9_-]`. Both devices of a pair must name the same room.
     - Lane H derives it from the pair, for example base64url of the first 16 bytes of SHA-256 over `clover-relay-v1 room\n<lower device id>\n<higher device id>`.
   - `peer`: 1–64 characters of `[A-Za-z0-9_-]`, this device's name for itself in the room (its device id).

A room holds two peers.

- **A third peer** is refused with 409 `full`.
- **A peer that opens a second socket** replaces its first, which closes with 4000.

Relay → client, as text:

| Frame | When |
| :- | :- |
| `{"t":"hello","v":1,"peer":{"online":bool}}` | first |
| `{"t":"presence","online":bool}` | the other peer's socket opened or closed |
| `{"t":"bye","reason":"replaced"}` | before a 4000 close |

- **Binary frames are the link's.** Each one a peer sends goes to the other peer as it is, in order.
  - A frame sent while the other peer is away is dropped; the link layer's own protocol resends what matters.
  - A frame is at most 1 MiB.
- **Client → relay text** is only `"ping"`, answered `"pong"` without waking the relay. Send one every 30 s. Any other text closes the socket with 4008.
- **Close codes:**

  | Code | Meaning |
  | :- | :- |
  | 4000 | replaced |
  | 4008 | protocol |

## Mail: sealed blobs for a device that is away

| Request | Body | Answer |
| :- | :- | :- |
| `PUT /v1/mail/<device>/<id>` | the sealed bytes; header `x-expires-at: <ms>` | 201, or 200 if the id is already there (unchanged) |
| `GET /v1/mail/<device>?max=<n>` | | `{"mail":[{"id","expiresAt","sealed"}]}`, oldest first, `sealed` in base64url |
| `POST /v1/mail/<device>/ack` | `{"ids":[…]}` | 204: those are deleted |

- **Taking mail doesn't delete it.** Mail stays until it is acknowledged or expires, so a device that crashes mid-take gets it again.
- **`device`:** 1–64 characters of `[A-Za-z0-9_-]`.
- **`id`:** 1–128 characters of `[A-Za-z0-9_-]`.
- **`max`:** 1–64, 16 by default.
- **Limits:**
  - one piece is at most 1 MiB
  - a mailbox holds at most 256 pieces and 64 MiB; past that, a put is refused with 409 `full`
  - `x-expires-at` is at most 30 days ahead
  - one take answers at most 8 MiB of mail

## Limits

- **Room sockets:** 120 opened a minute per client address (IPv6 by /64).
- **API requests:** 600 a minute per client address.
- **Each limit counts per Cloudflare location.** They protect the user's own quota, not access, which the key guards.
