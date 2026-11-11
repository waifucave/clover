# Signing the official plugin index

The owner holds the official plugin index's signing key (the answer of 2026-11-11 to question A). These are the steps
he follows to make that key, sign the index and its revocation list, publish them, rotate the key, and fill in what
the app ships. Spec: §5.1 "Indexes and npm", §5.7, §14.2 item 25.

Ground rules, whatever the step:

* The private key lives only in the owner's macOS **login keychain**. It is never written to a file, never committed,
  never in CI, an environment variable, a chat or a command line. The tool below reads it from the keychain by name,
  holds it in memory just long enough to sign, and never prints it.
* The app ships only the **public** key, in `OFFICIAL_INDEX` (`packages/core/src/registry/indexes/official.ts`), which
  stays empty in the repo until the key exists.
* Tests never use the real key: they make throwaway keys of their own.

## 1. Make the key (once)

On the owner's Mac, in a checkout of the repo:

```sh
scripts/pinned-bun scripts/plugin-index-key.ts create
```

This makes a new Ed25519 key, stores its 32-byte seed in the login keychain as a generic password (service
`com.waifucave.clover.plugin-index`, account `official`; pass `--service` and `--account` to name others), and
prints only the **public key** (64 hex characters). It refuses if a key is already stored under that name. Keychain
Access can show the item; nothing else holds it.

`scripts/plugin-index-key.ts public` prints the public key again whenever it's needed.

## 2. Write and sign an index

The index is a JSON file in format 1 (`IndexSchema` in `packages/plugin-sdk/src/formats/index-file.ts`):

```json
{
  "index": 1,
  "issued": "2026-11-20T12:00:00Z",
  "seq": 1,
  "name": "Clover plugins",
  "revocations": "https://<where it's served>/revocations.json",
  "plugins": [
    { "id": "luna", "name": "Luna", "versions": [{ "version": "1.0.0", "hash": "sha256:<tree hash>", "url": "https://<where>/luna-1.0.0.tar.gz" }] }
  ]
}
```

* `issued` is when it's signed (ISO 8601, UTC). `seq` is a number that **only goes up**: every published copy has a
  higher `seq` than the last. A client refuses a copy with a lower one (that is what stops an old copy being put back).
* Each version's `hash` is its tree hash (`clover plugin validate <folder>` prints it), and its `url` the `.tar.gz`
  of exactly that folder. A client installs it only if what it downloads has that hash.
* No adult plugin goes in the official index (§5.7).

Then sign it:

```sh
scripts/pinned-bun scripts/plugin-index-key.ts sign index.json --after <the seq last published>
```

The tool checks the file is an index Clover reads, with a `seq` above `--after`, signs the file's **exact bytes** with
the keychain's key, checks the signature, and writes `index.json.sig` beside it: one line of base64, a 64-byte Ed25519
signature. Any change to `index.json` after signing (a space, a trailing newline) needs signing again.

## 3. Write and sign the revocation list

Format 1 (`RevocationsSchema`), signed the same way with the same key:

```json
{
  "revocations": 1,
  "issued": "2026-11-20T12:00:00Z",
  "seq": 1,
  "entries": [
    { "id": "evil", "reason": "It sends your files to a server." },
    { "id": "luna", "versions": ["1.0.1"], "reason": "1.0.1 leaks its API key." },
    { "id": "nova", "hashes": ["sha256:<tree hash>"], "reason": "A bad build." }
  ]
}
```

```sh
scripts/pinned-bun scripts/plugin-index-key.ts sign revocations.json --after <its seq last published>
```

What an entry does (the controller's ruling B): the official list's `hashes` block a plugin with that tree from any
source; its ids (all versions, or the versions listed) block plugins installed from the official index. The `reason`
is shown to the user on the warning card and in Settings, labelled with who revoked it; keep it short and factual.
A revoked plugin stops on every computer at its next check (at start and every 6 hours); the user may still run it
after a warning card (the owner's answer C).

`seq` counts separately for the index and for the list. Sign a new list with a higher `seq` to lift an entry.

## 4. Publish

Commit `index.json`, `index.json.sig`, `revocations.json` and `revocations.json.sig` to the waifucave plugin index
repo on GitHub and serve them over https (GitHub Pages, or the raw files). The `.sig` must sit at the same URL with
`.sig` added (`…/index.json` → `…/index.json.sig`). The index names its list in `revocations`.

The app follows redirects only on https and only to public addresses, so a host that redirects elsewhere won't serve.

## 5. What the app ships: `OFFICIAL_INDEX`

In `packages/core/src/registry/indexes/official.ts`:

```ts
export const OFFICIAL_INDEX: IndexTrust | undefined = {
  url: "https://<where>/index.json",
  keys: ["<the public key from step 1, hex>"],
  issues: "https://github.com/waifucave/<index repo>/issues/new",
  revocations: "https://<where>/revocations.json",
};
```

`issues` is the "Report" link on a plugin's page: the app opens it with the plugin's id and tree hash filled in.
`revocations` is used only when the index file doesn't name its list. Only public keys go here.

## 6. Rotating the key

`keys` is a list, and any key in it verifies, so a rotation is:

1. Make the new key under a new account: `scripts/plugin-index-key.ts create --account official-2`.
2. Add its public key **beside** the old one in `OFFICIAL_INDEX.keys`, and ship that release.
3. Once enough users run a release that knows the new key, sign the next index and list with it
   (`sign … --account official-2`), with `seq` going up as always.
4. In a later release, take the old public key out of `keys`. Then delete the old keychain item.

If the old key is ever exposed, skip the wait: ship the release with only the new key, and sign with it at once.
Clients still on an old release keep their last good copy until they update.

## 7. If something goes wrong

* A client says the copy is "older than the copy already taken": the `seq` didn't go up. Sign again with a higher one.
* "its signature isn't by a key it's trusted under": the file was signed with a key that isn't in `keys`, or it was
  changed after signing.
* Nothing in this flow needs the private key outside the keychain. If a step seems to, stop: it's wrong.
