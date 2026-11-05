# Wyrmhole spec: second review of revision 12

Reviewer: a second Opus reviewer, read-only, November 4, 2026. It had the [final review of revision 11](2026-11-03-wyrmhole-spec-final-review.md) and the revision-12 diff.

Status: received November 4, 2026, and applied the same day as spec revision 13: sections A, B (as [P] defaults), E and F, with D's findings folded in; its decisions are spec items 58–62. The owner's answers to section C: on C1 he asked why a jail is needed at all, then chose to trust installed plugin code on Windows and Linux (no jail; the plugin's OK says what its code could do); on C2 he asked what Devin does, then chose Devin's way (each agent's own sandbox hides Wyrmhole's secrets file and run folder, and an agent with no sandbox starts only after the user's OK); C3 kept as is; C4 and C5 as recommended. Those answers replace the jail wording in A1 and A9, B2's macOS `stdio` sandbox sentence and C1's file jail for plugin code. Checked against the code and confirmed: A8 (the runtime's Bash profile allows four mach services, none of them the Keychain), A9's read deny (`runtime-sdk/mode-options.ts`) and B8's lock takeover (`packages/core/src/lock.ts`). Changed while applying: B5 also rules out accessibility presses; B12 sends a raise with its signed answer instead of asking on each computer; D11's Cloudflare relay only carries traffic, since finding direct paths uses STUN.

---

**Verdict.** Not ready to freeze. Revision 12 landed nearly every fix from the last review, but its own decisions add blockers. The Windows jail can't be narrow, and computer use can't run inside it (C1). On Windows and Linux an ACP agent can read the app's token and the device key, so it can answer cards (C2). "Bash keeps the Keychain" rests on a wrong fact about Winter (A8). Lease fencing stops bots in a waifucave outage (A2), and the always-on pair has no lock, stop, crash or update rules (B8). Freeze after A, C1–C5, B1, B4, B5 and B8.

## A. Contradictions and errors

**A1. The jail doesn't keep other writers out (§9.1 vs §5.2):** it "blocks only the secret store and the daemon's socket".
- Old: "* **Other writers** (`stdio` servers, host halves, computer use, agents) are kept out by the jail (§5.2) and the agents' own settings (§9.3)."
- New: "* **Other writers** (`stdio` servers, host halves, computer use) can write these files, since the jail (§5.2) blocks only the secret store and the daemon's socket; agents have them denied through their own settings (§9.3). What stops any writer from raising access is the core's own check."

**A2. Fencing stops bots in a waifucave outage (§6.4).** A single-computer user with an account loses every bot while waifucave is down.
- Old: "a main that can't renew its lease stops starting turns, tool calls and memory writes before the lease ends, with a margin for clock error."
- New: "a main that can't renew its lease stops starting turns, tool calls and memory writes before the lease ends, with a margin for clock error, unless no other computer could take over, or it still has a live link to each such computer that is on. A computer takes the lease only after failing to reach the main over every link, relays included."

**A3. "The device in use takes over" [D] vs "the first … wins" [P] (§6.4).**
- Old: "When several computers try to take over, the first to take the lease wins."
- New: "When several computers could take over, the one the user is using takes the lease first; if the user is on a phone, on the web page or away, the first computer to take it wins."

**A4. `wyrm`'s layer under a third-party shell (§5.5).** As written, the settings screen would share a replacement shell's process.
- Old: "Every plugin tree with UI code gets its own layer, and everything we ship under `wyrm` shares the shell's layer."
- New: "Every plugin tree with UI code gets its own layer. Everything we ship under `wyrm` shares one layer, the default shell's, and keeps it when a third-party shell fills `app.root`."

**A5. The settings screen and bot editor are UI plugins (§5.8), but the UI plugin API "cannot … change … settings".**
- Old: "The layers that run UI plugins have no Node, and their plugin API cannot answer cards, change levels, settings or devices, or read secrets."
- New: "The layers that run UI plugins have no Node, and their plugin API cannot answer cards, change levels or devices, or read secrets. Only the `wyrm` layer changes settings and user layers directly; another layer's change becomes a sealed card, and sensitive changes (below) are a sealed card from every layer."

**A6. The sensitive list misses what the fenced set now holds (§5.5).**
- Old: "Raising a routine's level, changing a computer's level, adding or revoking a device, choosing the main computer and loading a found plugin all end in a sealed card, so a plugin can ask for them but never do them silently."
- New: "Raising a routine's level, changing a computer's level, adding or revoking a device, choosing the main computer, loading a found plugin, adding a development folder, trusting a repo, and adding a saved allow rule or a connector permission all end in a sealed card, so a plugin can ask for them but never do them silently."

**A7. Two 10-minute rules.** §5.5 keys on the session. §9.1 and Winter's `isHumanTurnOrigin` key on who started the turn.
- Old: "A request from a routine or a background agent that nobody answers within 10 minutes is denied; a request from the user's own turn waits."
- New: "A request from a turn the user's own message did not start (a routine, another bot, a task notification, an agent working alone) is denied after 10 minutes unanswered; one from a turn the user started waits, in any session (§9.1)."

**A8. Winter's Bash doesn't keep the Keychain (§9.1).** The shipped runtime (`@yanlinglabs/winter-agent-runtime` 0.0.55, built from `winter-agent-sdk/packages/runtime/src/sandbox/profile.ts`) runs Bash under `(deny default)`. It allows four mach lookups, and securityd is not one of them. Winter's items trust `winter-core` alone, not its team. Opening the Keychain would let the CLI, which is the daemon's own binary, read its admin token under a bot.
- Old: "on macOS, Wyrmhole's Keychain items are tied to its own signing team, as Winter's are (`auth/credential-acl.ts`), so no other process, a bot's Bash included, is ever served them silently, and Bash keeps the Keychain for tools such as git."
- New: "on macOS, Wyrmhole's Keychain items trust the daemon's binary alone, as Winter's do (`auth/credential-acl.ts`), so no other binary is ever served them silently. As in Winter, Bash's sandbox denies the Keychain, so the CLI, the daemon's own binary, can't read its token under a bot; the git credential helper below serves macOS too."

**A9. Two fenced items need a read fence (§9.1).** Winter denies reading `<home>/run` (`runtime-sdk/mode-options.ts`). `systemd-creds` decrypts for any process of the user (D8), so a readable credential file is exposed.
- Old: "Bash's fence denies writing to them on every OS, and Winter's escape floor holds too: a command that leaves the sandbox still may not write them (§4)."
- New: "Bash's fence denies writing to them on every OS, and Winter's escape floor holds too: a command that leaves the sandbox still may not write them (§4). It also denies reading the run folder, as Winter's does, and any file that holds the credential store."

**A10. The cloud image has a display, so §3.1 doesn't say what runs there (§9.2).**
- Old: "* **[P] Official image:** Linux with a desktop session, the computer-use plugin's Linux backend and the Wyrmhole Browser, giving screenshots for computer use."
- New: "* **[P] Official image:** Linux with a desktop session, the computer-use plugin's Linux backend and the Wyrmhole Browser, giving screenshots for computer use. It runs the daemon alone, with Chrome for Testing (§12.1), and turns lingering on so the daemon starts at boot."

**A11. A tab "attached to no window" can't be captured (§12.1, D2).** This keeps the owner's decision and fixes only the means.
- Old: "A tab is either headless, attached to no window, or shown in the browser view, and it moves between the two without reloading."
- New: "A tab is either headless, in a hidden window that is never shown, or shown in the browser view, and it moves between the two without reloading."
- Old: "Headless tabs are not throttled in the background, and their screenshots are taken without showing them."
- New: "Headless tabs are not throttled in the background, and their screenshots are taken without showing them (`capturePage` with `stayHidden`); S7 checks Wayland, where frames can stop anyway."

## B. Gaps that would block a phase

**What each phase would still have to invent:**
- W0: a branch for Winter's hotfixes and its hand-over release.
- W1: the plugin API's calls and events, the index's signed revocation list, and whether Git for Windows ships inside.
- W2: B5, B7 and B8.
- W3: B11.
- W4: waifucave's APIs (lease length, signalling, push) and B12.
- W5: the remote file and shell protocol, and WinFsp's admin install.
- W6: B13.
- W7: the update order (B8).

**B1. W1: who counts as the user.** A double fork escapes a process-tree check. On macOS the CLI is the daemon's own binary, so the Keychain serves it the admin token. After "The daemon also checks a caller's process tree, so a command started by a bot, an agent or a plugin never counts as the user or the app (§5.5).": " **[P]** A caller counts as the user or the app only if it also runs outside every fence and jail: not sandboxed on macOS, in the host's namespaces on Linux, neither restricted (`IsTokenRestricted`) nor in an AppContainer on Windows. Leaving the sandbox never leaves the jail, so a `dangerouslyDisableSandbox` command still can't reach the socket or Wyrmhole's secrets. Bash's fence keeps Winter's closed doors on macOS (`open`, `launchctl`, `osascript`) and closes `systemd-run --user` on Linux and the Task Scheduler on Windows. A bot may run the CLI with its own session's rights."

**B2. W1, W2, W5, W6: phase rows that miss work the sections assign.**
- W1, after "the bot fence and the git credential helper (§9.1);": " Linux bash under bubblewrap; the local approval level and the rewritten reviewer (§9.1); the caller check (§3.1);".
- W2, after "the Wyrmhole Browser in the app and the browser view (spike S7),": " `mcp__wyrm__Browser`,".
- W5, after "cloud computers as plugin folders with the image and the Google Cloud and Hetzner provider plugins": ", the browser where no app runs".
- W6, after "direct coding sessions;": " in-process subagents (§14.2 item 15);".
- In §5.2, after "`stdio` servers run in the same jail.": " On macOS they run in the plugin host's sandbox too, as do hooks' commands."

**B3. W1: wrapping keeps pasted keys in the folder.** After "API keys and sign-in tokens go into the synced credential store, so a plugin folder can be shared or synced without leaking them.": " When the core wraps a pasted config, it moves every `env` and `headers` value into the credential store and writes `${secret:<name>}` in its place; the user can mark one as plain."

**B4. W1: model keys sit in the shared host's memory,** next to third-party code. After "A plugin gets only its own secrets, through the plugin API; workers in the shared host are not isolated from each other's memory.": " **[P]** So adapters never hold a key: a request that needs one goes out through the daemon, which adds the key or token. An adapter that must sign with the secret (AWS SigV4 for Bedrock) runs in a process of its own."

**B5. W2: sealed clicks need more than visibility.** IntersectionObserver v2 passes a tiny button and sees no other window (D4, D5). A helper with Accessibility can click the button. After "A click counts only while no other window overlaps the button and no computer-use action is running on that computer.": " **[P]** It counts only as real input (macOS: no other process posted it, by `eventSourceUnixProcessID`; Windows: not `LLMHF_INJECTED`; X11: not from XTEST), with the whole button showing at 24 by 24 CSS pixels or more and no browser view over it. On Wayland, plugin overlay windows hide while a card is pending, and only the focused Wyrmhole window takes clicks."

**B6. W2: styling can leave its tab, and glass themes hide every card.**
- A data-only bot's `position: fixed` can cover the whole window.
- Its `@keyframes` names are global.
- A frame preload runs in every subframe (D1).
- Blur on any ancestor sends every card to the fallback.

After "The CSS is cleaned first: no `@import`, `url()` only for files inside the folder, and no remote fonts or images.": " The tab's root has `contain: layout paint`, the cleaner prefixes global at-rule names with the plugin's id, and a layer's preload answers only frames of its plugin's origin. Every ancestor of an approval cell stays free of filters, opacity below 1 and transforms other than moves, whatever a theme says; S9 checks the waifu theme."

**B7. W2: "the smaller part" needs a measure.** Two entries in one spot dress the same spot, so the [D] example only works if a part means the plugin's whole footprint. After "When step 6 decides, Settings shows a conflict badge on that spot with a picker. Authors never set priorities.": " **[P]** The part an entry dresses is the smallest spot holding all its plugin's entries in that tab: a send-button plugin dresses the button, a bot's tab look the tab, a shell the app. The bots ticked when a part plugin is turned on are its `when.bot`; "all" includes bots added later. Sealed frames take only `card.*` tokens, so card styling is that set plus the `approval` entry."

**B8. W2 and W7: the pair, precisely.** See D9. Also, Winter's `lock.ts` lets a second daemon take over one that is still booting. After "A server or cloud computer with no display runs the daemon alone.":
"**[P] The pair, precisely:**
* One daemon per home, holding an OS file lock for its life; one app per user.
* Each starts the other through the OS (Launch Services and `launchctl kickstart`; the scheduled task; `systemctl --user start`). The daemon's unit restarts it only after a crash, so Quit holds until the next login.
* A side that exits on purpose tells the other first. A crashed app restarts with growing delays; after three crashes in two minutes, in safe mode.
* A daemon restart stops agents, the plugin host and background commands, and records running calls as interrupted.
* An update waits until the daemon is between turns and no agent runs, stops it, installs both and starts the pair.
* On Linux the app copies the daemon out of the AppImage and starts with the desktop session (XDG autostart). A server turns lingering on and updates its daemon itself, checking the same signature."

**B9. W2: the browser API.** After "DevTools access goes through each tab's own debugger and reaches only browser tabs, never the app's windows or the sealed cards; there is no debugging port.": " The API passes an allow list of CDP domains (no `Target`, `Browser` or `Storage`; no paths outside the bot's scratch), and the app's own schemes never serve browser partitions."

**B10. W2 and W7: Linux desktops.** GNOME shows no tray without the AppIndicator extension, which Fedora doesn't ship. Wayland has no always-on-top. An Electron AppImage on Ubuntu needs `--no-sandbox` (D9). After "Ubuntu 26.04 LTS and current Fedora, with Linux computer use on X11 first and Wayland experimental": ". **[P]** The deb and rpm, which install the AppArmor profile, are the main Linux packages. With no tray, a launcher entry carries Quit; on Wayland the island is a normal window."

**B11. W3: paths before the folder tree exists, and the rest of the migration.**
- After "The system prompt names all three.": " Until W5 there is no tree: the prompt names real local paths (`<home>/bots/<bot>/memory/` and so on), and W5 changes the prompt, not the files."
- After "The final Winter release that hands credentials over (§14.2 item 28) ships before W1's migration can read them.": " W3 migrates Winter's routines, paused, and Alpha's starting memories from `_assistant` (§14.2 item 12)."

**B12. W4: §8.5 has no row for settings and access.** After "| Scratch, device-local settings | Not synced |": "| Settings and access | Account settings, the user's picks, bots' user layers and connector permissions sync; levels, saved rules, trust and development folders stay local. A synced raise waits for a sealed card on each computer. Agent transcripts sync like memories |"

**B13. W6: the bridge's token,** which the agent can read. After "* **Messages from the agent:** the bridge MCP server gives the agent `SendMessage`.": "* **The bridge's link:** a token for that one agent session, whose role allows only its tool calls, `SendMessage` and `Glossary`."

**B14. First week.** A sleeping main takes every bot offline. A bot can type into a development folder through an editor it opened.
- After "The network adds little to a turn (§8.2).": "* **[P] Sleep:** a computer running bots stays awake while a turn, an agent or a routine runs, and wakes for its next routine; a laptop main hands its bots over before it sleeps."
- After "It never syncs, the fence keeps bots out of it (§9.1), and no agent's root may contain it.": " Adding one is a sealed card; while one is on, the tray shows it, each reload posts a notice, and it turns off after 24 hours unless renewed."

## C. Questions for the owner

**C1. Windows and Linux: hide Wyrmhole's secrets, or the whole store?** AppContainer runs at Low integrity and is closed to files, the network and other apps' windows, so computer use can't send input from inside it (D6). Denying the whole store also breaks `gh` and Docker in a bot's Bash.
- (a) **Recommended:** fence a file, not the store. Wyrmhole keeps its secrets and tokens in one file, encrypted with a key from the OS store. Bash, the plugin host and `stdio` servers run with that file and the run folder hidden: bubblewrap on Linux, with no D-Bus filter; on Windows, a restricted token with deny entries on the file and the pipe. Cost: our own store format, and S8 must prove the deny entries.
- (b) As written. Cost: the Windows jail needs grants for every folder and the network, and computer use can't run in it.
- (c) Linux as written. On Windows, each code OK says plugins can read saved logins and answer approvals. Cost: no Windows protection at 1.111.1.

**C2. ACP agents on Windows and Linux can answer sealed cards.** Item 52's settings can't stop an agent reading the OS store, which holds the app's token and the device key that signs answers. Claude Code's sandbox covers shell commands only, and doesn't run on native Windows (D10).
- (a) **Recommended:** run each agent inside the narrow jail (a restricted token on Windows, bubblewrap on Linux). Cost: a spike per backend. Ubuntu's bubblewrap profile forbids nested sandboxes, so Claude Code's own sandbox can't start inside ours (D7).
- (b) Deny the secrets and the run folder through each agent's own settings (Claude Code's `permissions.deny` and `sandbox.filesystem.denyRead`, a Codex permission profile), and mark the rest. Cost: unsandboxed backends can still read them.
- (c) Say so in each backend's OK.

**C3. CLI installs "were already confirmed there".** On macOS we never sandbox an ACP agent. It can run the CLI, which is the daemon's binary and gets its token, in a reparented process that passes any caller check.
- (a) **Recommended:** the CLI asks and a sealed card answers, for installs, development folders and other sensitive changes. Cost: one more click, and a server's CLI needs another device to answer.
- (b) Keep CLI confirmation for callers that pass B1's check and have a TTY. Cost: agents on macOS still pass.
- (c) Keep as is.

**C4. What ⌘Q does.** As written, a habitual ⌘Q on the main takes every bot offline until the lease lapses, along with that computer's routines and agents.
- (a) **Recommended:** ⌘Q quits the pair, but first says what stops and offers "Hand over and quit", which releases the lease at once. Cost: a dialog on the main.
- (b) ⌘Q closes windows; only the menu-bar Quit stops the pair. Cost: unlike most Mac apps.
- (c) Keep as is.

**C5. A shared part "is the same in each" tab [D], but "Tokens flow down" [P].**
- (a) **Recommended:** one layer and the same code, taking each tab's tokens. Cost: none.
- (b) One look everywhere, from the global theme. Cost: it won't match a bot's tab.

## D. External claims checked

1. **Per-plugin origins as out-of-process frames: holds with limits.** Electron forces site isolation on. A site is the scheme plus the registrable domain, or the full host if there is none. The scheme must be registered as `standard`, and a frame preload then runs in every subframe. https://raw.githubusercontent.com/electron/electron/main/shell/browser/electron_browser_client.cc
2. **`WebContentsView` with no window: partly wrong.** `capturePage` returns an empty image for a view with no bounds. Re-attaching without a reload works but is undocumented. On Wayland "frames stop firing, even with background throttling being disabled". https://github.com/electron/electron/issues/53814
3. **`@scope (…) to (…)`: holds** (Chrome 118), for selectors only: inherited properties "still inherit, beyond the lower bound". https://developer.chrome.com/docs/css-ui/at-scope
4. **IntersectionObserver v2: holds, conservatively.** Across frames, a target counts only when the parent reports it "guaranteed not occluded". It sees only "other page content", never other windows. https://w3c.github.io/IntersectionObserver/v2/
5. **Wayland: no window positions, no always-on-top.** `getPosition` returns `[0, 0]`, and `alwaysOnTop` is "Not supported on Wayland". https://www.electronjs.org/docs/latest/api/browser-window , https://github.com/electron/electron/issues/50403
6. **AppContainer as a narrow jail for Bun: wrong.** "AppContainers run with a Low Integrity Level", isolated from other apps' windows, files, the network and credentials. SendInput injects only "at an equal or lesser integrity level". A restricted token keeps Credential Manager readable, and Git Bash needs the user among its restricting SIDs. https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer , https://github.com/zavora-ai/adk-rust/pull/1037
7. **bubblewrap with xdg-dbus-proxy: holds, with Ubuntu's limits.** The proxy is default-deny ("All other clients are invisible"). AT-SPI needs a second proxy. Ubuntu 26.04's `bwrap-userns-restrict` profile denies nested sandboxes. https://gitlab.com/apparmor/apparmor/-/raw/master/profiles/apparmor/profiles/extras/bwrap-userns-restrict
8. **`systemd-creds --user`: holds** (added in v256; Ubuntu 26.04 has 259.5). It decrypts for any caller with the same UID (`p.uid == peer_uid`), so only file permissions protect the blob. https://raw.githubusercontent.com/systemd/systemd/main/src/creds/creds.c
9. **The pair's OS pieces: hold with limits.**
   - Electron's single-instance lock covers only the app.
   - `setLoginItemSettings` does nothing on Linux.
   - Squirrel.Mac aborts an update "because there are %lu running instances of the target app".
   - The NSIS installer kills processes in the install folder.
   - electron-builder ships the AppArmor profile for deb and rpm, not for AppImage.

   https://github.com/Squirrel/Squirrel.Mac/blob/master/Squirrel/SQRLInstaller.m , https://github.com/electron-userland/electron-builder/issues/8635
10. **Claude Code and Codex through their ACP adapters: hold with limits.** Claude Code takes `_meta.claudeCode.options`, but "The sandbox covers shell commands only", and there is none on native Windows. Codex has no per-session writable roots. A Codex permission profile's `deny` "Denies both reads and writes", so §9.3's "writable roots" really means a profile. https://code.claude.com/docs/en/sandboxing , https://learn.chatgpt.com/docs/permissions
11. **iroh relays on Cloudflare Workers: no implementation exists.** A Durable Object could host the relay's websockets, but address discovery needs UDP. Item 57's Cloudflare option would be a relay we write ourselves. https://docs.rs/iroh-relay/1.0.2/iroh_relay/http/index.html
12. **Keychain partition lists: hold with limits.** The partition check comes on top of the item ACL, so a second binary from the same team still prompts. But under `Bun.secrets`, a re-run of the same binary is served silently. https://github.com/oven-sh/bun/issues/28071

## E. Previous review's fixes that did not land, or landed wrong

- The status line's Keychain correction was wrong. The previous B2 ("securityd on macOS, as for Winter's Bash today") was right (A8).
- B1's "the bash fence denies the daemon's run folder" landed as a write deny only (A9).
- B3's "a TTY not running under a bot or an agent" became a process-tree check, which a double fork escapes (B1).
- E1's "never controls itself" was meant as a core rule, but landed as a rule plugins "must not" break, with nothing enforcing it (B5).
- B5's fencing landed, but as written it stops bots in an outage (A2).
- B16's phase rows still miss work (B2).
- Everything else from A, B, E and F landed and reads correctly.

## F. Wording

- "| Secrets | Keychain | Credential Manager | libsecret, or an encrypted file as a last resort |" → "| Secrets | Keychain | Credential Manager | the Secret Service; with none unlocked, `systemd-creds --user`, else a plaintext file only the user can read (§8.5) |"
- "| bubblewrap or Landlock |" → "| bubblewrap (Landlock can't filter D-Bus) |"
- "It runs under its own identity, not the daemon's" → "It runs as a separate signed binary, never as a re-run of the daemon's (which would pass)"
- "Local ones (wrapped, hand-made, bot-written) are copied from the main, and an edit on another computer goes to the main first." → "Local ones (wrapped, hand-made, bot-written) are copied from the main, and an edit on another computer goes to the main first; while the main is offline, the takeover computer stands in for it."
- "each site or bot in its own session partition" → "each bot's tabs in that bot's own session partition and the user's in another"
- "* Each site or bot should get its own session partition, so logins and cookies never mix with the app's own." → "* Partitions are per bot, never per site, so sign-ins that hop domains keep their cookies; none mixes with the app's own."
- "The page connects to the main computer over WebRTC data channels, with waifucave doing the signalling." → "The page connects to the computer running the bots over WebRTC data channels, with waifucave doing the signalling."

A script confirmed that every quoted Old text and placement sentence occurs exactly once in `~/Xcode progects/Norma v2/docs/wyrmhole-spec.md`. No repo file was touched, and my `review-r12/` scratch folder has been deleted.
