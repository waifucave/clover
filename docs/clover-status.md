# Clover status board

Kept by the controller ([plan](clover-plan.md) §11). Last updated November 5, 2026. The contract is [the spec](clover-spec.md), now at revision 18.

## Now

* **Merged and tagged:**

  | PR | Lane | Merge | Tag |
  | :- | :- | :- | :- |
  | #152 | C0 | `714e03421` | `c0` |
  | #149 | K-M0 | `64c6d3475` | `k-m0` |
  | #156 | I-M1 | `8d3c22499` | `i-m1` |
  | #150 | H-M0 | `60a4f984c` | `h-m0` |
  | #148 | C-M0 | `2725557bf` | `c-m0` |
  | #160 | M-M0 | `dc86e40ce` | `m-m0` |
  | #153 | J-M0 | `027565946` | `j-m0` |
  | #155 | F-M1 | `4b70c6b66` | `f-m1` |
  | #159 | G-M1 | `e474e0a36` | `g-m1` |
  | clover-sdk #61 | A-M1 (SDK) | `0d47c5e4` | `v0.0.63` |

* **SDK 0.0.63:** all eight `@waifucave/clover-*` packages are on GitHub Packages. npm publishing comes later, and lane A is making the SDK's npm release job opt-in.
* **In flight:**
  * **A (#158):** switching to 0.0.63 and merging main. Then merge, tag `a-m1`.
  * **B (#157):** its last review round is pushed and being checked. Then merge, tag `b-m0`, then D's #161, tag `d-m1`.
  * **L (#151):** decisions 92–94 written into its S7 report. Then merge, tag `l-m0`.
  * **E (#154):** decision 94 written into its S9 report, with an upstream report drafted. Then its reviewer checks the WebRTC parts, then merge, tag `e-m0`.
  * **The controller:** spec revision 18, the plan's updates and this board.

## Lanes

| Lane | Milestone | Branch | PR | State |
| :- | :- | :- | :- | :- |
| A | M1, the embedded runtime | `lane/a-m1` | #158 (clover-sdk #61 merged, `v0.0.63`) | switching to 0.0.63, merging main, making the SDK's npm job opt-in |
| B | M0, the spine's contracts | `lane/b-m0` | #157 | last review round pushed; reviewer checking |
| C | M1, the daemon everywhere | `lane/c-m1` | | started (C-M0 merged) |
| D | M1, a bot | `lane/d-m1` (on `b-m0`) | #161 | approved; adding Alpha's look lines after G, merging main and `b-m0` |
| E | M0 S9 / M1, the shell's host | `lane/e-m0` / `lane/e-m1` | #154 | M0 done, reviewer's final check running; M1 started |
| F | M2, the shell on the runtime | `lane/f-m2` | | started (F-M1 merged) |
| G | M2, the surfaces and Live2D | `lane/g-m2` | | started (G-M1 merged) |
| H | M1, identity and links | `lane/h-m1` | | started (H-M0 merged) |
| I | M2, the relay, the web, the handshake service | `lane/i-m2` | | started; the handshake wire format first, for H |
| J | M1, the tree (no mounts) | `lane/j-m1` | | started (J-M0 merged) |
| K | M1, the Agent tool | `lane/k-m1` | | started (K-M0 merged) |
| L | M0 S7 / M1, the Clover Browser | `lane/l-m0` / `lane/l-m1` | #151 | M0 done, merging main for the gate, then merge; M1 started |
| M | M1, packages (and main green) | `lane/m-main-green`, `lane/m-m1` | | main's layout tests and Dependabot first, then Bun 1.4, then M1 |

## Machines

* **Google Cloud VMs for lane C:** one Windows Server 2025 VM and one Ubuntu 26.04 LTS VM. Both stop themselves after 8 hours of running. Lane C stops them when it's idle, and the controller checks they're stopped when C reports.
* **The heavy-job limiter:** `scripts/heavy`, three slots.

## Departures from the plan

* **The Windows VM runs Windows Server 2025, not Windows 11.** Google Cloud offers Windows 11 only on sole-tenant nodes. Both share the 24H2 base, and a real Windows 11 machine is still live gate 3.
* **Every "remote" lane runs locally.** The Agent tool's remote isolation quietly ran lane H in a local worktree, so cloud agents aren't available from the controller's session. Plan §8's fallback applies: A, B, D, F and K run locally too, with CI for the other OSes.
* **K-M0 ran locally, not remote.** Spike S5 needed the Cursor and Antigravity CLIs, which a cloud session doesn't have.
* **The spikes started before C0 merged.** Their branches sit on the docs commit `a481f7e14`, pushed as `c0/docs`, which is also the first commit of `c0/rename`. They add only new paths, so they rebase cleanly.
* **D waits for the spine.** The real S4 check needs the owner's Fish key (live gate 5), so D's M0 is a client and a fake, folded into D-M1.
* **F's M1 grew.** The owner asked for Claude's desktop layout, so the panels, the settings modal and the language chooser started in M1, as plain React against mocks.
* **Wave 2 started before B-M0 merged.** Lanes build against B's contracts as they stand on `lane/b-m0`, which are reviewed and close to final; a lane that needs a contract change asks the controller.

## The owner's decisions

Spec items 76–94, written into revision 18 (spec §14.2):

* **76, §9.1, Windows credentials:** Windows bash runs as a dedicated sandbox principal. gh, git credential helpers, Docker registry logins and ssh-agent signing reach it only through a Clover credential broker, which never hands over raw keys (as on Linux).
* **77, §5.5, "renders once":** one origin and process per shared plugin, one frame per place it appears, state held by the core, and each frame themed by its tab.
* **78, §9.3, Cursor:** accepted with the workspace folder and its deny rules as the boundary. Settings marks it as "edits inside its folder without asking".
* **79, §8.3, presence and QAD (S1's edit 6):** n0's relays stay on by default and may see which devices are online, from which IPs and how much they send. QAD is on.
* **80, §8.3, the dial policy (S1's edit 6):** (c), chosen per pair from a two-STUN check. Pairs whose two STUN answers match dial direct with a 0.5 s head start (and a second dial at 100 ms); the rest race the relay at once.
* **81, §8.3, devices paired without an account (S1's edit 6):** at first pairing they save a pair credential. Afterwards they use waifucave's handshake service with it, with no account. n0's address lookup is the fallback. (The owner's own idea; H designs the client side and I the service in M1/M2.) "No relay for coordination" and "relays only carry traffic that can't go direct" are reworded to match.
* **82, the island:** the same top-centre island on all three OSes, themed by tokens, with no fixed Apple blue. On screens without a notch it grows from the top edge.
* **83, the default shell:** laid out like Claude's desktop app (Code view):
  * the left sidebar
  * the conversation with collapsed runs
  * the composer with model and level pills
  * panel toggles at the top right
  * a right panel holding the session view, terminal, diff, browser and files, each panel a replaceable plugin
  * the settings modal and the language chooser

  It uses Clover's own marks, with no Claude logo, mark or wording.
* **84, §5.2, the plugin host:** the bundled `clover` tree's host halves run in a plugin-host process of their own, and third-party host halves share the other one. The core decides which process from the install record. Only the `clover` process may use the waifucave token and `keys.open`.
* **85, §6.4 and §14 item 17:** devices paired without an account get the same automatic hand-over of the main computer (the lease) as account devices, coordinated through waifucave's handshake service with the pair credential.
* **86, the default shell's look:** match Claude's desktop app almost exactly:
  * radii, spacing, colours, borders, states and type, measured from the owner's screenshots
  * Clover's own icons (an open-licensed set), system fonts and wording
  * controls follow the OS accent, and Clover's pink only in its mark
  * the left sidebar translucent (macOS sidebar material, Windows acrylic, solid on Linux)
  * the top bar semi-translucent, with the transcript scrolling beneath it
  * the sidebar its own plugin
  * two panels stacked
* **87, avatars:** a bot's avatar is VRM **or** a Live2D Cubism model, rendered by the owner's clean-room runtime Mochi2D (`waifucave/Mochi2D`, MIT). Alpha's avatar becomes a Live2D model.
  * Lane G builds `plugins/clover/live2d` in G-M2, with VRM-style caps and lip sync from the speech feed only.
  * The package is `@waifucave/mochi2d` on GitHub Packages.
  * No agent opens `waifucave/Lively2D-research` (the dirty room).
* **88, §9.1, no OS mounts:** other computers' folders are never mounted into a file system; there's no NFS, WinFsp or FUSE.
  * Clover works on each folder through the computer that holds it: the holder's daemon serves the tree over the link, behind the holder's fence.
  * The Files panel exists only in code sessions, rooted at the session's folder. Bots have no file view.
  * The speed-versus-freshness choice ("files fresh, folders 1 s") is moot.
* **89, S6's edits 7 and 8:** builds and git run on the computer that holds the files, and moves and copies between computers take a direct fast path.
* **90, bot-side panels:** a bot's tab gets a slim column (agents and tasks, context, outputs) and the browser panel.
  * The bot's running ACP agents show in the slim column. Clicking one opens it in the right panel as a code-session-style transcript, with its own composer and model picker but without the code panels or a slim column.
  * Code sessions keep the full set: the session column, terminal, changes, files (rooted at the session's folder) and browser.
* **91, who may answer another computer's card:** any desktop, as well as phones; browsers never.
  * The owner accepted that a compromised plugin on a Windows or Linux computer could approve actions on the owner's other computers.
  * Desktops still sign with an app-held key where the OS can protect it (the macOS Keychain, Windows Hello or the TPM).
  * Receivers always rebuild the card for the bound call and compare hashes.
* **92, §12.1, the bots' browser (S7's edit 1):** design B. Bot tabs render offscreen with no window and are shown through a viewport without reloading, as the previous app's headless helper did. §3.1 and §12.1's [D] stay as written.
* **93, screen-reader users:** a hybrid. While a screen reader is on, new bot tabs start as real views in a hidden host window (design A, only then), so no tab ever reloads.
* **94, Electron (decision 2 of S7's edit 1, and S9's WebRTC gap):** "Stock Electron, wait upstream". Clover ships stock Electron with no patches.
  * The browser patches S7 proposed (popups, dropdowns and dialogs) are dropped. Electron #55565's same-site popup case works only while the person watches.
  * The WebRTC escape S9 found stays a documented known gap: a plugin UI can still send WebRTC connectivity checks to an undeclared address. The no-patch belt and the preload stub stay on where they help.
  * Fixes go upstream instead.

How the work runs:

* **November 5, agents:** only Claude agents and sessions. On a safety block, the same work goes to OpenCode or Cursor; Codex is out.
* **November 5, SDK publishing:** GitHub Packages only for now; npm later.
* **November 5, upstream reports:** lane H's findings went upstream where they weren't already known.
  * Filed: n0-computer/iroh#4657, and a comment on iroh-ffi#276.
  * The two Bun reports weren't filed: one is a duplicate, the other is fixed in Bun 1.4.4.
  * At the owner's choice, both posts say they were written and posted by an AI agent on the owner's behalf.

## Controller rulings

* **November 5, lane C, the key-file fallback:** plan §9's "secrets never on disk" covers real secrets in an agent's work. Keys generated in a temp home for a test are not secrets. Spec §8.5's headless fallback stays as written ([P]): `systemd-creds --user` with the TPM where one exists, otherwise a key file only the user can read, labelled as plaintext, which the fence hides. The reason is that cloud computers must keep working unattended. The alternative lane C proposed, keeping the store locked until someone unlocks it, is rejected for the same reason.
* **November 5, tokens:** lane B's catalog is the source of truth for every theme token, names and `--clover-` prefix both. F and G rename to it, and B makes the mapping collision-free.
* **November 5, the forwarder's key:** core-held per computer (`keys.publicKey`, `keys.open`, HPKE base mode); the private key never enters the plugin host. A synced worker secret is out.
* **November 5, lane I's departures, all agreed:**
  * `/<tag>/<routine>` URLs, folded in as wording
  * the Durable Object encrypts ([P])
  * every computer on the account is a recipient ([P])
* **November 5, F's panels:** `plugins/clover/panel` is the panel host, and each panel is its own plugin, `plugins/clover/panel-<name>`, all F's. The browser panel's live view is lane L's, and the files tree's data is lane J's.
* **November 5, `native/link/`:** approved for H-M1's addon, next to `native/link-sidecar/`. Plan §4 has it.
* **November 5, tokens, refined:** B adopted G's catalog. The catalog is G's names, with B's `--clover-` prefix (dots as hyphens). A plugin's own tokens are `plugin.<id>.<name>`, with hyphens in the id as underscores in CSS.
* **November 5, the keyed fetch's placement** (A's review, B1): never per call. The core holds it from the plugin's `auth` entry, from a fixed allowlist (`authorization` plus a scheme, `x-api-key`, `api-key`, `x-goog-api-key`), and strips response headers that echo the token. Applies to both A's `createKeyedFetch` and B's `net.fetch`.
* **November 5, the SDK's default brand:** required at the session boundary, failing closed. Pulled forward from A-M2, because a missed thread would land on the owner's live install's home.
* **November 5, zod (M's alert 3):** string caps stay in UTF-16 units on the wire. B adds the helper, and M then bumps zod.
* **November 5, child plugin layout:** the repo mirrors the installed tree (`plugins/clover/plugins/<child>`). Lane M moves every child in one commit after F, G and I's M1 PRs merge.
* **November 5, identity:** C0's `process-identity.ts` stays (installed at core load, never removed, and in the CLI). It calls SDK 0.0.63's `installBrandIdentity`. Lane A drops its own install.
* **November 5, levels** (B's review, S1): a total order, read-only < ask < ask-risky < accept-edits < automatic. Accept-edits is ask-risky plus edits and moves. Read-only is absolute; no saved rule beats it. Lane C confirms in C-M1.
* **November 5, panel ownership** (F's review round 2, should-fix 7):
  * `panel-terminal`, `panel-diff`, `panel-files` and the sidebar plugin are F's. Plan §4 has them.
  * The browser panel is L's: `browser-view` fills `panel` keyed `browser`. F hands its design over to L.
  * Backends: the PTY is lane J's (a shell on any computer), the session's changes and diff are lane D's, and the tree is J's.
* **November 5, lane C's edit 7 (the Windows principal's writable profile):** accepted for M0 only. M1's floor:
  * nothing carries over between commands or sessions, concurrent ones included
  * the profile and hive are reset per session, measured on every launch and failing closed
  * the vendor's grants and temp folders are per session
  * a fenced list of auto-run paths is only interim
  * one §9.1 rule for all three OSes' login-start locations
* **November 5, account-less pairs** (H's four problems and the reviewer's gaps):
  * **Keys:** a signing key per device per pair, or the link key with a domain-separation prefix. Both devices sign the registration.
  * **Revoking:** a revoke ends the pair at the service, after §8.1's local revoke.
  * **Limits:** registration is rate-limited hardest. Per-IP limits group IPv6 by /64 and leave carrier-NAT headroom. Short TTLs on addresses, presence and dial-now, not on registrations. Replay protection on signed requests.
  * **What the service keeps:** current state only, with end-to-end encrypted payloads.
  * **The n0 fallback:** only account-less devices publish to n0's lookup, with the relay URL only. Links refuse unpaired and revoked keys.
* **November 5, the account-less lease with three or more devices** (H's finding on decision 85): use a group record per user for their account-less devices. Each device joins the group at pairing, and the service holds one lease record per group, so "the first computer to take it wins" still holds. This links the pairs only within one user's own devices, which is acceptable. Per-pair leases could split the main computer, so they're rejected. H-M1 item 14 builds it, with lane I.
* **November 5, the Cursor `Co-authored-by` trailer** on lane C's `94ae95409`: it stays; no history rewrite.
* **November 5, Bun 1.4:** lane M moves CI and the daemon to Bun 1.4.x. Reasons: H's timer finding (fixed in 1.4.4) and A's Worker-churn crash on 1.3.14 (A's review, S3). Run the full suites and A's soak first.

## Blockers

* **S9, the WebRTC escape: decided** (item 94, "stock Electron, wait upstream"), so it is a documented known gap. In stock Electron 45 a plugin UI can send WebRTC connectivity checks with page-chosen text to an undeclared address, through a remote ICE candidate in a remote description, on all three OSes, with CSP, the request filter and `Connection-Allowlist` all on. The spec's old [D] "WebRTC is off in plugin origins" couldn't hold in stock Electron; revision 18 replaces it.
* **S9, the renderer kill:** in frames created inside a restricted document, Chromium 156 kills the plugin's renderer. It's fail-closed, detected by a process-ID census, and accepted with decision 94.

## Questions for the owner

1. **Upstream posts, waiting for the owner's go-ahead:** lane L's Electron drafts (a comment on #55565 and three new issues) and lane E's WebRTC report (`docs/research/2026-11-05-electron-webrtc-remote-candidate-upstream-report.md` on `lane/e-m0`). Ask once E's reviewer has checked E's.
2. **G, Alpha's assets (spec §14.2 item 26):** the real Live2D model, the portrait and their licence. The PRs ship placeholders made by code.
3. **A-M2, the MCP OAuth client document (outward-facing):** Clover needs its own client document on a waifucave host instead of the previous app's, on `yanlinglabs.com`. Ask when A-M2 starts.

Answered since: J's mounts (items 88 and 89); L's edit 1 and the patched Electron (items 92–94).

## Controller notes

* The five Dependabot alerts on main (one high) go to lane M.
* **M-M0 also took CI for `plugins/**` and `services/**`** (from F's review, item 9), and retires the lane gallery workflows into CI.
* **Lane A, after its review:**
  * Make the npm release job skip cleanly when its token is absent.
  * Point CI and dev installs at GitHub Packages (`@waifucave:registry=https://npm.pkg.github.com`, with a read token in CI). Every developer machine then needs a GitHub token with `read:packages`.
  * Tag `v0.0.63` after clover-sdk #61 merges.
  * Use C0's identity install (`process-identity.ts`), per the identity ruling.
* For lanes C, K and A (from L's review): on Linux the daemon spawns only through `Bun.spawn` until lane C isolates the `node:child_process` stall. The reproduction recipe is in the S7 report.
* For lane C (from L's review):
  * Windows pipe handles need an explicit inherit list (`STARTUPINFOEX`).
  * The fence must deny `/proc/<pid>/fd` on Linux, using a PID namespace in bubblewrap, and deny process access on Windows.
  * Per-bot browser profiles belong in the fenced set.
* For lanes C and M (from H's review): the link sidecar is a second executable that holds the device key, so it needs the fence and secret hiding (S8) and signing and notarisation.
* For lane D (from I): the forwarder's pull model (`next`, `ack`, `drop`), the routine key passed to `register`, `receivedAt` for missed runs, and dropping repeats by delivery `id`.
* For lane H (from I): account tokens signed ES256 or EdDSA, checked against a JWKS (`iss`, `aud`, `sub`, `dev`, `iat`, `exp`). Revoking a device also calls the forwarder's and push's device DELETEs.
* For lane I (from C0's review): the iOS kit tag's `Package.swift` still downloads the Iroh xcframework from the old `yanlingLabs` repo's releases, relying on GitHub's redirect. Fix it at the next kit tag.
* For lane M (from L's review): Task Scheduler XML, launchd `ThrottleInterval`, `SMAppService`, the AppArmor profile and the server package's dependencies.
* For lanes E and C (from L): the Windows logon task must run `clover-core supervise`, because Task Scheduler never restarted a crashed daemon. The pair's details are in §5 of the S7 report.
* For lanes B, E and G: the avatar's speech feed. G sends the frame shape; B pins it in the `avatar` spot; E checks it crosses layers.
* **For lane M:** `web.test.ts:269`, htmlToText's linear-time test, flakes on CI's macOS runner (124 ms against a 100 ms bound on #157). Make the bound robust (a ratio against a baseline run in the same process, or a wider absolute bound).
* **Branch protection:** `gate` is the required check on main (not strict, no force pushes or deletions). Branches from before M-M0 have no `gate` check until they merge main; the controller merges those after checking every other check.
* **Installs from GitHub Packages** (lane A sets this up for the whole `@waifucave` scope, `@waifucave/mochi2d` included):
  * The repo's `.npmrc` sets `@waifucave:registry=https://npm.pkg.github.com`, with `_authToken=${NODE_AUTH_TOKEN}`.
  * CI uses `packages: read` with the workflow token.
  * Local installs run `NODE_AUTH_TOKEN=$(gh auth token)`, which needs `read:packages`.
  * Each private package grants the clover repo's Actions read access.
* For lane C-M1 (from D): the fenced set includes `<home>/user-layers`, `<home>/transcripts` and `<home>/usage`.
* For lane D, after G's #159 merged: add Alpha's icon, avatar, theme, layout and themes lines to `plugins/alpha/clover.json`, as listed in D's report.

## Next merges

1. **L-M0, #151,** once main is merged in and the gate passes: tag `l-m0`.
2. **A-M1, #158,** on SDK 0.0.63 with main merged: tag `a-m1`.
3. **B-M0, #157,** after its reviewer's check: tag `b-m0`. Then **D-M1, #161:** tag `d-m1`.
4. **E-M0, #154,** after its reviewer checks the WebRTC parts: tag `e-m0`.
5. **The controller PR:** spec revision 18, the plan's §4 and §8, and this board.
