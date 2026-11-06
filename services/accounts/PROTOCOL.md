# waifucave's account service, wire format v1

The account service keeps each waifucave account's device list and mints the account tokens that waifucave's other services check: the hooks forwarder, push and the handshake (spec §8.1, "the account is the root of trust"). Signing in itself is waifucave's Supabase project, with email, Discord and Google. This service takes a Supabase session and answers for the devices of that account.

The wire is lane H's proposal (the core's `identity/account.ts`, which `AccountClient` speaks), built here with the additions marked below. This file is the contract between the service (lane I, `services/accounts/`) and the core (lane H). Change it only together.

## Where it lives

- Production: `https://waifucave.com/auth` (`PATH_PREFIX` `/auth`), the issuer the other services' production profiles name. The paths below follow the prefix. A host of its own works too, with `PATH_PREFIX` empty and `ISSUER` set to match.
- The local profile (`wrangler.jsonc`'s top level) is what the tests and emulators run. It adds two things production never has:
  - keys made in memory (`EPHEMERAL_KEYS`);
  - `POST /dev/token`, a mint without a sign-in (`DEV_MINT`), for emulator tests that need a token and no account.

## Calls

| Request | Body | Answer |
| :- | :- | :- |
| `GET /.well-known/jwks.json` | | `{"keys":[…]}`, the public halves of the signing keys, cached for 5 minutes |
| `POST /v1/devices` | `{"device": {"id","publicKey","boxKey","name","kind","os"?}, "t", "sig"}` | 201 `{"device"}`, or 200 `{"device"}` when the device was already listed (its fields updated) |
| `GET /v1/devices` | | `{"devices":[…]}`: every device of the account, the revoked ones with `revokedAt` |
| `DELETE /v1/devices/<id>` | | 204, again 204; 404 for a device the account never had |
| `POST /v1/tokens` | `{"aud","dev","t","sig"}` | `{"token","expiresAt"}` |

Every `/v1` call takes the Supabase access token as `Authorization: Bearer`. The service asks the project who it belongs to (`GET <project>/auth/v1/user`, with the project's public key as `apikey`), so a signed-out session is refused as soon as Supabase refuses it. An anonymous Supabase sign-in is not an account.

A device's record:

```json
{"id": "<32 base32 characters>", "publicKey": "<Ed25519 link key, standard base64>", "boxKey": "<X25519 key, base64url>",
 "name": "Studio", "kind": "desktop", "os": "macos", "addedAt": 1793000000123, "revokedAt": 1793000500000}
```

- `id` is lane B's `deviceIdFor(publicKey)`: lowercase base32 of the first 20 bytes of SHA-256 over the key. Any other id is 400 `bad_device_id`.
- `publicKey` may be sent as standard base64 (as the core's `DeviceKey` gives it) or base64url; it is kept and listed as standard base64.
- `boxKey` is 32 bytes. It is the key the handshake's account-scope boxes are sealed to (`services/handshake/PROTOCOL.md`, "Boxes").
- `name` is 1–64 code points with no control characters. `kind` is the protocol's `DeviceKind` (`desktop`, `server`, `cloud`, `phone`, `browser`) and `os` its `Os` (`macos`, `windows`, `linux`).

## Statements

A registration and a mint are signed by the device's link key, Ed25519, over UTF-8 lines joined by `\n`. `sig` is base64url, and `t` is the device's clock in milliseconds:

```
clover-account-v1 register
<account: the Supabase user id>
<device id>
<t>
```

```
clover-account-v1 mint
<aud>
<device id>
<t>
```

- `t` must be within 10 minutes of the service's clock (400 `bad_time` otherwise).
- **Replay protection** (an addition to H's proposal): a registration's `t` must be newer than the last one that device registered with, and a mint's `t` newer than the last one it minted with for that audience. Otherwise the answer is 409 `replay`. A refused call spends nothing.
- A registration's statement names the account, so it doesn't register the device in another one.

## Tokens

The token is a JWS (compact JWT), signed EdDSA or ES256 under a key of the JWKS:

```json
{"alg": "EdDSA", "kid": "…", "typ": "JWT"}
{"iss": "https://waifucave.com/auth", "aud": "push.waifucave.com", "sub": "<account>", "dev": "<device id>",
 "iat": 1793000000, "exp": 1793000300, "jti": "…"}
```

- It lives 5 minutes (`TOKEN_TTL` may shorten it), and `expiresAt` is `exp` in milliseconds. The core refuses any token that would live longer (`ACCOUNT_TOKEN_MAX_MS`).
- `aud` is one service, from `AUDIENCES`: `hooks.waifucave.com`, `push.waifucave.com` or `handshake.waifucave.com`. Anything else is 400 `bad_audience`.
- Only a listed device that isn't revoked gets one (403 `not_member`), and only with its own key's signature (403 `bad_signature`).
- The services check it offline (`services/shared/account-token.ts`), against this JWKS fetched by URL and cached (`services/shared/jwks.ts`).

**Keys.** In production they are `SIGNING_JWKS`, a secret: private JWKs with `kid`s. The first signs and every one is published. A rotation adds the new key first and drops the old one once its tokens have ended. A set with a key that doesn't import is refused whole (503 `not_configured`), and so is a production service without the secret. It never makes keys of its own.

## Revocation

- `DELETE /v1/devices/<id>` revokes a device of the account, taken from any of the account's sessions. The device stays listed with `revokedAt`, so every other device learns of it.
- A revoked device can't register again (403 `revoked`), and gets no tokens.
- The tokens it already holds end within 5 minutes. The other services hear of the revoke from the revoking device itself (lane H's fan-out: their `DELETE /v1/devices/<id>` calls), not from here.

## Limits

- **Per client address** (IPv6 by /64), before Supabase is asked: 120 calls a minute.
- **Per account:** 60 calls a minute.
- Each limit counts per Cloudflare location. Limited calls are 429 `rate_limited` with `retry-after: 60`.
- **Devices** (an addition to H's proposal): an account may list 64 devices that aren't revoked (409 `full` for one more). It keeps at most 256 rows; past that, the device revoked longest ago is forgotten first.
- Bodies are at most 16 KiB.

## Errors

The body is `{"error": "<code>"}`:

| Status | Codes |
| :- | :- |
| 400 | `bad_request`, `bad_device_id`, `bad_time`, `bad_audience` |
| 401 | `unauthorized`: no session, or one Supabase refuses; the client refreshes its session and tries once more |
| 403 | `bad_signature`, `revoked`, `not_member` |
| 404 | `not_found` |
| 409 | `replay`, `full`, `conflict` (an id already listed with another key) |
| 429 | `rate_limited` |
| 503 | `auth_unavailable` (Supabase can't answer; `retry-after: 30`), `not_configured` |

A bad signature is 403 rather than H's fake's 401, so `AccountClient` doesn't refresh a good session over it.

## Cross-origin

The web companion (`https://clover.waifucave.com`) may call the service from the browser once it signs in. The service answers CORS for that origin alone (`WEB_ORIGINS`).

## Testing against it

`@waifucave/clover-service-accounts/harness`: `startAccountService({authUrl, anonKey, tokenTtlSeconds?, devMint?})` runs the service on wrangler's local runtime against a sign-in stack such as lane M's stub. It answers `{url, issuer, jwks, stop}`, the same as the core's `startFakeAccountService`, with a signing key made in memory for the run.
