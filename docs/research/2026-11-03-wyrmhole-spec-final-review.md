# Wyrmhole spec: final review of revision 11

**Status:** received November 3, 2026, from the Opus final reviewer (read-only), and applied November 4 as spec revision 12: sections A, B (as [P] defaults) and F, the corrections in D and the placements in E. The owner's answers to section C: questions 1, 2 and 6 as recommended; 3 with layered rendering and "the plugin that dresses the smaller part wins"; 4 kept as is; 5 first as recommended, then changed to the browser inside the app, with the app and the daemon as one always-on pair; 7 with n0's relays on by default and a setup-guide page to swap them. Two corrections were made to this report: macOS 27 has shipped (Apple silicon only), so the floor is macOS 27 and `darwin-x64` is dropped; and Winter's Bash sandbox was said not to block the Keychain. That second correction was wrong, and this report was right: the runtime's Bash profile allows four mach services, none of them the Keychain. The [second review](2026-11-04-wyrmhole-spec-second-review.md) caught it, and revision 13 restores the block.

---

**Verdict:** The spec is close but not ready to freeze. The decisions fit together, and every § and "item N" reference points to the right section. Four things need fixing first:
1. Sealed cards protect what a card shows, not how an answer reaches the core. Computer use, overlay windows, socket clients and companion plugins can all answer (B1, C6).
2. The bot fence and "trust my edits" assume the core knows who wrote a file. It can't know that for agents, MCP servers or background processes (B2, B3, C2).
3. Multi-device has no lease fencing, no log order that survives late events, and no path for memory (A1, B5, B6).
4. About two dozen leftovers from earlier revisions remain; each is a one-line fix (A).

Freeze after A, B1–B10 and the owner's answers to C.

## A. Contradictions and errors (pure fixes)

1. **Log order (§8.5 vs §6.4).** The spec says "merging is the union sorted by stamp". But §6.4 puts a late message "after that output, showing its real send time". Sorting by stamp would move that message before output the model wrote without it. Events from a main that went offline unsynced would land wrongly the same way.
   - Old: "Append-only logs of stamped events; merging is the union sorted by stamp (§6.4)"
   - New: "Append-only logs. The computer running the bot gives each event its place, and every copy keeps that order. The user's messages keep send order among themselves; the stamp shows the send time (§6.4). Events from an earlier lease that arrive late go at the end, marked late."
   - Winter's phone sync already refuses a stale `baseSeq` (`packages/core/src/ipc/sync.ts`).
2. **Who refreshes tokens (§9.1 vs §8.5).** "The computer doing the thinking refreshes it" lets each routine computer and `saveTo` caller refresh the same rotating token. §8.5 forbids that.
   - New: "Only the refresher of §8.5 refreshes it. Another computer that makes the call uses the current token and asks the refresher when it expires."
3. **One term, two meanings.** §9.1 defines "the computer doing the thinking" as "the main, or the device that took over while the main is off". §5.2 also runs turns on "the main, the takeover device, a routine's computer".
   - New, stated once in §6.4: "**[P] The computer running a session:** the main (or the takeover computer) for a main conversation; the routine's computer for a side thread; the agent's computer for a background agent."
   - Use that phrase in §5.2 and §9.1.
4. **Code sessions (§3.3 vs §9.3).** "move to the same embedded path" conflicts with two [D]s: "Winter's own coding mode becomes an ACP agent" and "Each agent runs as its own process".
   - New: "Code sessions stop going through the router. In W1 they run embedded. In W6 they become Winter's coding agent, an ACP agent started like any other (§9.3)."
5. **W3 webhooks have no way in.** W3 ships "routine files (schedule and webhook triggers)". But the only bundled ingress, the forwarder, arrives in W4 with the account it needs.
   - New: W3 has "the schedule trigger"; W4 adds "the webhook trigger and the waifucave forwarder plugin".
6. **VM deletion.** `onRemove?: "ask" | "keep" | "delete"` lets a folder a bot wrote, or someone shared, delete a VM on a later `rm`. That VM may be the main. This breaks §9.2's "Removing the folder asks".
   - New: `onRemove?: "ask" | "keep"; // deleting a VM always asks`.
7. **Local edits skip the re-ask rules.** "Data edits (themes, layouts, CSS) apply at once" lets a local manifest edit add an `http` server or a network host without asking. An update that did the same would ask.
   - New: "A local edit asks again on the same triggers as an update. Other data edits (themes, layouts, CSS, Markdown) apply at once."
8. **Index updates.** "The OK is bound to the tree's hash" and "A code change to a plugin asks again" contradict "plugins from an index update automatically".
   - Append: "For an index plugin, the OK also covers later versions that add none of the §5.6 triggers."
9. **Edits made off the main.** "are copied from the main; a file changed on two devices at once" leaves edits made on other computers undefined.
   - New: "…are copied from the main. An edit on another computer goes to the main first. If two computers change one file before they sync, the later write by the shared clock wins. The other copy is kept as `<file>.conflict-<device>`, and counts as a code change if it lands in code."
10. **OS floors.** "Ubuntu 24.04 LTS and current Fedora" sits under "[D] … latest OS versions only". Ubuntu 26.04 LTS is out, and it is the version on which `systemd-creds --user` works (D10).
    - New: "Ubuntu 26.04 LTS".
    - Raise "macOS 26 or later" to macOS 27 once it ships; Apple's FSKit docs already list macOS 27 APIs.
11. **`WinterChatKit`.** "`WinterChatKit` | Kept for the iOS companion" contradicts "Retire: the phone's own chat engine". That engine *is* `apple/WinterChatKit` (`ChatEngine.swift`, `SyncClient.swift`).
    - New: keep `WinterProtocol` and `WinterKit`; "`WinterChatKit` retires with the phone's chat engine (§14.2 item 18)".
12. **Output styles.** "**Output styles:** fold into" conflicts with §12's [D], which lists "Workflows, output styles, LSP" as returning later as plugins.
    - New: "**Output styles:** for bots, `<bot-instructions>` covers them; for coding sessions they return later as a plugin (§12)."
13. **Two `waifu` themes.** `wyrm` ships "Fish Audio, the VRM renderer and the waifu theme", and Alpha also contributes `{ "id": "waifu", "file": "tab/theme.json" }`. Theme ids must be unique.
    - New, in Alpha's example: `"theme": "alpha"` and `{ "id": "alpha", "file": "tab/theme.json" }`.
    - `wyrm`'s waifu theme stays the global default.
14. **Diagram.** "Wyrmhole Browser (headless, §12.1)" sits inside the Bun daemon, but Bun can't host Electron's Chromium.
    - New: draw it as its own box: "Wyrmhole Browser (headless, §12.1): its own process, driven by the daemon". C5 picks which process.
15. **Point names.** "Point names are dotted, and a new point should start with the declaring plugin's id" fails three ways:
    - The spots `sidebar`, `main`, `panel`, `conversation` and `composer` have no dots.
    - `island.tab` doesn't start with `wyrm/island`.
    - The spec says points are "declared in the `declares` field of one of the plugin's contributions", but the schema has `declares` only on triggers and `ui`.

    New: "A point declared by a `ui` entry is a spot, filled through `ui`, and can have any name. A point declared by a trigger is filled with a top-level dotted key in `contributes`. New names start with the declaring plugin's id; the SDK's well-known names are exempt."
16. **`when`.** "`when` applies to UI only" conflicts with `McpServer`'s `when?: { os?: Os[] }`.
    - New: "`when.bot` applies to UI only".
17. **One bridge, not two.** "Wyrmhole attaches a small MCP server to the agent's ACP session" conflicts with the table's single bridge, which "also provides `SendMessage` and `Glossary`".
    - New: "**Messages from the agent:** the bridge MCP server gives the agent `SendMessage`."
18. **Hooks and agents.** §5.1 says "Scope covers a plugin's MCP servers, skills, agent definitions and hooks". But §9.3's table has no hooks row, and an ACP agent runs its own loop.
    - New row: "Hooks | Only on calls through the bridge, and on in-process subagents | An ACP agent's own loop is out of reach".
19. **In-process subagents.** "or the SDK's in-process subagents" puts the core runtime behind a plugin point, and `AgentBackend.protocol` only allows `"acp" | "cloud"`.
    - New: "…an ACP or vendor cloud agent (§9.3); in-process subagents are a core backend (§14.2 item 15)."
20. **Main-only placements.** Two placements stop working while the main is off.
    - §5.2's row reads "the main (desktop notifications run on each computer)". New: "the main, or the takeover computer while the main is offline".
    - `Glossary`'s index lives "in the core, on the main computer". New: "on every computer that runs sessions, built from the synced plugins".
21. **Tool rows.**
    - "core except the web and computer-use tools" leaves out the browser tool. New: "the web, computer-use and browser tools".
    - "As a local tool, it takes a `computer` field" conflicts with "A server on one computer gets no field". New: "On two or more computers it takes a `computer` field". The same applies to `mcp__wyrm__Browser`.
22. **Phase dependency.** "as can W5 and W6 once W4's device registry exists" ignores that W6's roots and paths use W5's folder tree.
    - New: "W6 starts with local placement once W4's device registry exists. Placement on other computers waits for W5's folder tree."
23. **§14.2 bookkeeping.**
    - Item 6 ("models and bots on the main") predates §5.2. New: "host halves start where their contributions run (§5.2, §9.1)".
    - "its decisions are items 34–42", but items 43–46 sit under the same heading. Add "items 43–46 came with revision 10".
    - "Defaults written in as [P] with revision 11" misses these revision-11 defaults:
      - in §5.1, child switches, no name dependencies and wrapper names
      - model plugins as `wyrm` children in the plugin host (§3.3)
      - helpers started through Launch Services (§5.2)
      - how points are declared and how they wait (§5.4)
      - web pages (§5.5)
      - one bot per plugin (§6.1)
      - namespaces (§6.7)
      - points in `Glossary` (§6.8)
      - cloud computer folders (§9.2)
    - Revision 10's routine-file defaults (§7) appear in no list.
24. **Cost wording.** "Cloudflare's cost never rises with how long a payload is held" contradicts the next line, "Stored data is billed per GB-month".
    - New: "Holding a payload longer adds almost nothing to the cost, if the object takes sockets through the Hibernation API (D9)".

## B. Gaps that would block a phase

1. **Answers are not sealed (W2, W4).** "The core accepts a click only while its button is visible and uncovered" protects the display, not the path an answer takes. Five paths skip the button:
   - UI plugin code can use the shell's own channel to the daemon.
   - A host half, a `stdio` server or a bot's command can open the daemon's socket.
   - Computer use can click the button. Winter's "never controls itself" floor (`WINTER_OWN_BUNDLE_IDS`, `packages/core/src/computer-use/protocol.ts`) is lost.
   - A transparent always-on-top window can sit over the button. IntersectionObserver v2 only sees content inside the page.
   - The companion plugin carries the phone's answer, and the card's text with it ("The native iOS app shows approval cards").

   New, after "How":
   "**[P] Only sealed buttons answer.**
   - The core takes an answer only from a sealed frame, or from a paired device's app. A frame answers over a channel the app's main process opens for that frame alone. A device signs over the card's id and hash with its device key.
   - The core's link carries cards and answers; a companion plugin never sees either.
   - The renderer that runs UI plugins has no Node. Its plugin API cannot answer cards, change levels, settings or devices, or read secrets.
   - Socket clients prove their role with a token, as in Winter (`hello` and the per-role method lists in `packages/core/src/ipc/server.ts`). Plugin processes and bots' commands never get the app's token, and the bash fence denies the daemon's run folder.
   - A click counts only while no other window overlaps the button and no computer-use action is running on that computer.
   - Computer-use plugins learn where Wyrmhole's windows are through the plugin API and must not act on them. Ours blacks them out of screenshots.
   - The 2-second fallback also fires when the buttons are on screen but reported hidden. A transform, a filter or opacity below 1 on the frame or any ancestor hides them, so card styling may not use these (D2)."
2. **The fence is partial (W1, W3).** "A core fence keeps bots' tools away from the files that hold settings" has five gaps:
   - It leaves out items Winter fences today: saved allow rules, connector permissions, the trust record, agent definitions and the `run` folder (`sandboxConfigFor`, `packages/core/src/runtime-sdk/mode-options.ts`).
   - It ignores other writers: `stdio` file servers, host halves and computer use.
   - It assumes files, but on Windows and Linux the secret store is not a file.
   - It says "Bots change those only through core tools", yet §6.7 has no such tool.
   - No phase builds it.

   New [P]: "The fenced set is settings, levels, saved rules, connector permissions, trust, the device list, bots' user layers, the credential store and the daemon's run folder. On every OS, Bash's fence denies writing to them. It also denies the OS secret store: securityd on macOS, as for Winter's Bash today; Credential Manager on Windows; the Secret Service on the Linux session bus. A change made outside the core takes effect at once only if it lowers access. A change that raises access waits for a sealed card. No tool changes these items; a bot asks the user. Built in W1."
3. **Who made a change, and what the OK says (W1).** The spec says "the core re-hashes those plugins after each" bot call. That misses a background process the bot started, an ACP agent, an MCP server and computer-use typing; each would pass as the user. Also, "installs made through the app or the CLI were already confirmed there" lets a bot run `wyrmhole plugin install` in Bash. And `generated.by` is self-declared, so a bot can claim to be the user.

   New [P]: "'Trust my edits' works only for a development folder passed with `--plugin-dir`. Such a folder never syncs, the fence keeps bots out of it, and no agent's root may contain it. In the plugins folder, every code change asks. A CLI install counts as the OK only from the user's own terminal: a TTY not running under a bot or an agent. The OK shows the author from the core's own record of who wrote the files. It also:
   - says that the hosts listed are only the ones the plugin declares
   - flags `stdio` commands that fetch code at run time (`npx`, `uvx`)
   - marks plugins from outside the official index 'not reviewed', since `adult` is self-declared"
4. **Routine levels (W3).** "when the tool or an edit sets it above the computer's level" ties the OK to nothing. A bot can get a harmless routine approved, then rewrite or move it.

   New [P]: "A raised level is bound to the routine file's hash and to its computer. Editing the triggers or instructions, or moving the file, drops it back to the computer's level until a new OK. Lowering never asks. A webhook routine's card says that anyone with the URL can start it. `Routine` writes an `id` into the frontmatter, and a file without one gets one when loaded. The same-id rule and the webhook URL both use it. After a move, the new computer's forwarder re-registers the routine. A removed bot's routines pause."
5. **Takeover safety (W4).** "Another device takes over only after the lease lapses" never makes the old main stop, and ignores a tool call in flight.

   New [P]: "A main that can't renew its lease stops starting turns, tool calls and memory writes before the lease ends, with a margin for clock error. Events carry their lease epoch. A tool call's start syncs before the call runs. A takeover computer that finds a started call with no result records 'interrupted, may have run on <computer>'. It never re-runs that call on its own, and the real outcome is posted once the link returns. When several computers try to take over, the first to take the lease wins. The returning main takes each bot back at that bot's next idle moment."
6. **Where memory lives (W3, W4).** No path is given. "is the only writer" breaks once side threads on other computers write memory locally. Agent transcripts go "into a transcript file on the main computer, the bot's home", even while the main is off.

   New [P]: "A bot's memory is `bots/<bot>/memory/` at the top of the tree. It always resolves to the computer running the main conversation, and side threads use it over the link. Agent transcripts go in `bots/<bot>/agents/`. Scratch is `home/<Computer>/.wyrmhole/scratch/<bot>/`. The system prompt names all three."
7. **The tree on disk (W5, S6).** "whose own entry links to its home folder" puts the tree where `grep -r ~`, Spotlight or a backup could walk into every other computer. Computer names have no rules either.

   New [P]: "The tree's root sits outside every home folder: the FSKit mount on macOS, `$XDG_RUNTIME_DIR/wyrmhole` on Linux, a drive letter on Windows. A computer's own entry is a symlink (a junction on Windows). Indexers and backups skip the mounts. Computer names are unique and use only letters, digits and hyphens; a renamed computer keeps its old name as an alias. A command that can write into another computer's mount is judged by the stricter of the two levels."
8. **Levels, fence scope and the reviewer (W1, W3, W5).** "The user can change the level for each computer." lists no levels, and "writes limited to the allowed folders" lists no folders.

   New [P]: "The levels are read only, ask, ask for risky actions (the default: Winter's `auto` with the reviewer), accept edits, and fully automatic (`bypass`). Until W5, one level covers the local computer. Bash may write in the home and temp folders, except the fenced set, under Winter's network rules. That is wider than Winter's working-folder fence, so the reviewer prompt is rewritten. The reviewer chooses its model by Winter's `reviewer.model` rules, and asks the user when no model can run. As in Winter (`isHumanTurnOrigin`), a card or question from a turn that the user's own message did not start is denied after 10 minutes."
9. **Credentials in model plugins (W1, W4).** "carrying its adapter, its catalog and its sign-in" would hand refresh tokens to plugin code.

   New [P]: "As in Winter (`packages/core/src/runtime-sdk/host-credentials.ts`), refresh tokens never leave the core. The core refreshes `oauth-pkce` sign-ins itself, and only on the refresher. A `custom` sign-in handler refreshes only when the core calls it there. Adapters get access tokens by reference, with a generation number, and ask for a newer one after a 401. Computers other than the refresher get the new token over the link."
10. **Hook order (W1).** "A hook can block or adjust inputs and results, under time limits" doesn't say where hooks run relative to approval. As written, a hook could change a command after it was approved.

    New [P]: "`tool.before` hooks run first. The reviewer, the fences and the approval check then judge the input as the hooks left it, as in Winter. Nothing changes an input after it is approved. `tool.after` changes only results."
11. **Prompt rebuilds (W3, W5).** Under "The block is rebuilt only at compaction", a conversation under about 100k tokens never rebuilds. Appended notes pile up, and a server mirrored in the meantime has no `computer` field. Also, "load only while a bot works inside that trusted repo" has no test for "inside".

    New [P]: "If the cache has already expired, the next turn rebuilds the MCP block, the devices block and the `computer` lists without compacting. Until then, a call without `computer` goes to the server's previous computer. A bot works inside a repo while the turn's Bash folder, or a file tool's path, is in it. The repo's items stay for the rest of that turn."
12. **`saveTo` and agents (W5, W6).** "and files the call returns are saved there" defines neither what a file is nor where an ACP agent's remote calls run.

    New [P]: "A call's files are its embedded resources and images. The core writes them to `saveTo` (or to scratch if none is given) and puts their tree paths in the result. Every remote tool gets an optional `saveTo`. An ACP agent's bridged remote calls run on the agent's computer."
13. **Holds (W5).** With "The holds belong to the computer-use plugin on each computer.", two plugins can drive one window at once.

    New [P]: "The core keeps each computer's holds and the user-working mark. Computer-use plugins take and release them through the plugin API. That API also tells B1's click rule when an action is running."
14. **Voice on companions (W3, W4).** "Voice runs on the device the user is talking on." can't work on the iOS app or the web page, which run no plugins.

    New [P]: "On the iOS app and the web page, the client records and plays the audio. The voice plugin runs on the computer running the bot."
15. **Lifecycle details lost from the proposals' rules 6–10 (W1).** "loads, reloads or unloads plugins live, with no restart" leaves these undefined.

    New [P]:
    - "On reload, the worker is replaced. In-flight tool calls get a grace period, then are recorded as interrupted. Model calls retry. The client half remounts and loses its state.
    - A removal syncs as a delete; user data stays under the plugin's id.
    - Bundled plugins, and children of index plugins, can only be switched off.
    - A refused plugin stays off until its folder changes.
    - Safe mode also starts no third-party host halves or hooks.
    - Assets are served by hash, SVG with scripts off and never through a symlink. Markdown renders without raw HTML."
16. **Work no phase builds.** These have no phase today:
    - The final Winter release that hands credentials over (§14.2 item 28). It must ship before "Winter settings and logins migration" can read the Keychain.
    - Credential sync and the single refresher (W4).
    - The bot fence (W1).
    - The plugin index, its revocation list and the index browser (W1–W2).
    - The bot editor (W3) and the archive view (W2).
    - `commands` (W1).
    - Waifucave push (W4) and desktop notifications (W2).
    - The 18+ gate.
    - Moving the remote gateway out of the Swift app (W4).
    - The pause switch (W3).
    - The release pipeline for three OSes (a W7): electron-updater, dmg and Homebrew, the Windows installer and winget, AppImage and deb, notarization.

    Each spike in §14.1 should open its phase.
17. **The user layer (W3).** "writes a user layer over the plugin, or forks it" doesn't say what the layer holds.

    New [P]: "The user layer holds the user's changes to a bot's name, instructions, model, effort, voice, avatar, theme and layout. A field it sets wins over the plugin's, and Reset clears it. Bots cannot write it. A bot changes itself by editing its plugin folder, which sits under the user layer."

## C. Questions for the owner

1. **Bot edits that restyle approval cards.** The OK mentions "restyles approval cards" only once, when the plugin is found, and theme edits then apply at once. So a prompt-injected bot could make deny look like approve in its own tab, or add "Deny" beside approve with CSS `content`.
   - (a) **Recommended:** a bot's edit to such a plugin keeps the card styling at the last version the user OK'd, until the user OKs the change. Cost: one card per such edit.
   - (b) Any bot edit to such a plugin asks again, as code does. Cost: more cards.
   - (c) Keep as is. Only the first OK guards.
2. **ACP agents and the fence.** "does not wrap it in another sandbox (macOS cannot nest them)" lets a bot delegate what its own tools can't do: edit settings, levels, plugins or routines. The agent's edits also pass as the user's.
   - (a) **Recommended:** pass the fence to each agent through the agent's own settings: Claude Code's deny rules and sandbox `denyWrite`, Codex's writable roots. `Agent` refuses roots that contain the Wyrmhole home, and any permission request that touches a fenced path is always a card. Cost: work per backend.
   - (b) Also wrap agents in our fence on Windows and Linux, where nesting works. Cost: two models.
   - (c) Accept that agents act as the user.
3. **"Only its own tab" for code.** "A bot's plugin styles its own tab, and only its own tab" is checked in the manifest. But a bot's components "run in the renderer without an iframe sandbox" and can reach every tab.
   - (a) **Recommended:** make it a rule, not containment. The OK for a bot with components says "runs code in the whole app". Cost: a shared bot with code can still change everything.
   - (b) Containment: each bot tab gets its own renderer. Cost: memory per tab, and harder UI across tabs.
4. **A stolen login.** Under "Signing in is enough to add a device." plus full sync, a stolen waifucave, Discord or Google sign-in gets every key, every token and Bash on every computer.
   - (a) **Recommended:** keep adding the device on sign-in. Credentials and computer access reach it only once an existing device approves it, or after 24 hours with a notice and a one-tap revoke everywhere. Cost: a wait for a user who adds a device alone.
   - (b) Require two-factor sign-in to add a device. Cost: Discord and Google sign-ins depend on those accounts' own security.
   - (c) Keep as is.
5. **Where the browser lives on desktops.** The spec says "the browser is Electron's own Chromium with no window", but the Bun daemon can't host it. Inside the app's main process, the browser dies when the app quits and shares a process with the sealed cards, and its API exposes "the DevTools protocol" there.
   - (a) **Recommended:** give it its own windowless Electron process, started by the daemon, with DevTools reaching only its tabs. The browser view streams it, even on the same computer. Cost: no live attach (D4).
   - (b) Keep it in the app's main process, with DevTools per tab and no debugging port. Cost: it shares a process with the sealed cards.
   - (c) Use Chrome for Testing everywhere. Cost: a larger download.
6. **Sealed cards on Windows and Linux.** "host plugins can read the user's secrets until an OS sandbox exists" means they can also read the app's token, and so answer cards.
   - (a) **Recommended:** at 1.111.1, put the plugin host in a narrow jail (AppContainer on Windows, bubblewrap on Linux) that blocks only the secret store and the daemon's socket. Cost: a W1 spike.
   - (b) Say in every code OK on Windows and Linux that the plugin can answer approvals.
   - (c) Defer.
7. **Phones without a relay.** The spec says "Relays are plugins, and none is on at first." Winter's phone uses n0's public relays today (`apple/WinterKit/Sources/WinterSessionKit/RelaySelection.swift`). Without a relay, a phone on mobile data often can't reach a home computer, which breaks "a bot is live on every device that is on".
   - (a) **Recommended:** ship a relay plugin for n0's public relays, off by default and end-to-end encrypted. Offer it in one tap when a direct connection fails. Cost: a third party carries encrypted traffic.
   - (b) Keep as is. Cost: away from home, phones need a cloud computer.
   - (c) Waifucave runs a relay. Cost: money.

## D. External claims checked

1. **"FSKit on macOS 26, FUSE on Linux, and a file-system driver": holds for macOS.**
   - `FSGenericURLResource` (macOS 26) may be "some sort of network address for a remote file system".
   - macFUSE 5.1.0 added "non-local" volumes on macOS 26.
   - The user must enable the extension in System Settings, and it ships as a native extension inside the app.
   - macFUSE 5.5.0 worked around an FSKit data-corruption bug.
   - Sources: https://developer.apple.com/documentation/fskit/fsgenericurlresource , https://github.com/macfuse/macfuse/releases/tag/macfuse-5.1.0
2. **"Chromium's IntersectionObserver v2": holds, with limits.**
   - It is Chromium-only, since Chrome 74.
   - `isVisible` is false under any transform other than translation or upscaling, under opacity below 100%, or under any filter. This applies to the target or anything above it, across frames.
   - `delay` must be at least 100 ms.
   - It sees only page content, and it may report false negatives.
   - Source: https://w3c.github.io/IntersectionObserver/#calculate-visibility-algo
3. **"without the castLabs Electron build": holds.**
   - castLabs' build is maintained (44.9.3, October 2026).
   - Production use on macOS and Windows also needs VMP signing, through castLabs' free EVS service.
   - Source: https://github.com/castlabs/electron-releases/wiki/VMP
4. **"attaches the live page (`WebContentsView`)": holds on one process only.**
   - A WebContents lives in the main process, in one view at a time.
   - On Linux, Electron "requires a display driver" and has no headless mode.
   - Source: https://www.electronjs.org/docs/latest/api/web-contents-view
5. **"Official napi binding `@number0/iroh`; Bun support unconfirmed": holds.**
   - iroh 1.0 shipped June 15, 2026, and the bindings are official again (1.2.0).
   - Bun is not mentioned.
   - The macOS prebuild covers Apple silicon only, so `darwin-x64` needs a source build or the sidecar.
   - Sources: https://iroh.computer/blog/v1 , https://github.com/n0-computer/iroh-ffi
6. **"$15 per million bytes of text", and the free and listening prices: hold.**
   - There is no subscription or minimum, and the page carries no date.
   - `s2.1-pro-free` comes with "No TTFA or DPA guarantees".
   - Source: https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits
7. **"Gemini CLI, Grok CLI (`grok agent stdio`)" and the adapters: hold.**
   - The adapters are `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp`.
   - DeepSeek Harness's `acp` profile is limited to one workspace.
   - "Cursor's ACP support still needs checking" can be closed: Cursor's CLI runs `agent acp`. Whether it accepts MCP servers passed in by us is unverified.
   - Gemini CLI's free and Google One tiers moved to Antigravity CLI on June 18, 2026.
   - Sources: https://agentclientprotocol.com/overview/agents , https://cursor.com/docs/cli/acp
8. **"accepts MCP servers; every agent supports stdio": holds.**
   - Stdio is a MUST, and `session/request_permission` and `session/cancel` exist as described.
   - Source: https://agentclientprotocol.com/protocol/session-setup
9. **"100,000 requests and 100,000 rows written per day", and the $5 plan: hold.**
   - "An idle object waiting for a device is not billed for time." holds only with the WebSocket Hibernation API. Plain `accept()` bills the whole connection.
   - Incoming messages bill at 20:1, and auto-response pings are free.
   - Source: https://developers.cloudflare.com/durable-objects/platform/pricing/
10. **"sealed with systemd-creds and the machine's TPM": wrong on Ubuntu 24.04.**
    - `--user` arrived in systemd 256. Ubuntu 24.04 has 255, where the key is root-only.
    - Ubuntu 26.04 has 259, so A10 fixes this.
    - Source: https://raw.githubusercontent.com/systemd/systemd/v256/NEWS
11. **"such as WinFsp, or Windows' Projected File System": half wrong.**
    - ProjFS doesn't write back. Modified files become local "full files", and enabling it needs elevation.
    - WinFsp works. Its licence is GPLv3 with a FLOSS exception, but it is a kernel driver.
    - New: "such as WinFsp"; drop ProjFS here and in §14.1 item 6.
    - Source: https://learn.microsoft.com/en-us/windows/win32/projfs/cache-state
12. **Smaller claims: hold.**
    - "`Bun.secrets` already maps to macOS Keychain": since Bun 1.2.21, still experimental. Linux needs a secret-service daemon (https://bun.com/docs/api/secrets).
    - Windows-MCP's "its telemetry is on by default": yes, via `ANONYMIZED_TELEMETRY` (https://github.com/CursorTouch/Windows-MCP).
    - nut-js: the fork's last release was March 13, 2025, and upstream prebuilt packages need a subscription.
    - "(`--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS`)": both exist. Git for Windows is now optional in Claude Code (https://code.claude.com/docs/en/cli-reference).

## E. Winter features not placed

These spec claims about Winter hold: the scheduler (`packages/core/src/routines`), `REMOTE_ALLOWED_METHODS`, QR pairing with a 4-word check, held apps, `usage.db`, the workflow workers' Keychain sandbox, digest tool names, mid-turn folding, and the 10-minute rule.

What follows is not placed anywhere:

1. **"Winter never controls itself"** (`WINTER_OWN_BUNDLE_IDS`, `packages/core/src/computer-use/protocol.ts`). Place it at "screen control outside the bot's own windows", as a core rule (B1).
2. **Socket roles and tokens** (`packages/core/src/ipc/server.ts`, `auth/app-token-acl.ts`). Place them at "the transport is a Unix socket on macOS and Linux and a named pipe on Windows" (B1).
3. **The credential broker:** locators, generations, and refresh only in the daemon (`runtime-sdk/host-credentials.ts`). Place it at "only one device refreshes a login at a time" (B9).
4. **The self-grant fence and sandbox escapes:** `dangerouslyDisableSandbox` and the escape floor (`runtime-sdk/home-fence.ts`). Place them in B2's list and in §4's Bash row.
5. **Web floors:** the dangerous-domain list, asking before private addresses, and `audit.jsonl` (`docs/claude/tool-surface.md`). Place them at "Web search and page fetch; the search provider can be swapped".
6. **The phone link:** iroh-ffi 1.1.0, n0 relays, the signed relay list, and the Swift `Gateway` that connects as `remote` (`apple/WinterKit`). Place it at "keeps its native Swift app, re-pointed at Wyrmhole"; the gateway moves into the daemon in W4.
7. **Tools:** the to-do list (`TaskCreate` and the rest), `TaskOutput`, `Monitor`, `NotebookEdit`, worktrees, the MCP resource tools, Exa `Search` and the advisor (`runtime-sdk/tool-names.ts`). Place each at "any other plugin tool" as core, coding-agent only, or retired. MCP resources matter, since MCP is on the 1.111.1 floor.
8. **Installed Claude-format plugins** (`<name>@<marketplace>`, `docs/claude/runtime-home.md`). Place them at "skills and agents are wrapped as plugins": unpack them, or keep them off until Claude-format plugins return.
9. **The hardware broker:** the battery charge limit through the app's XPC helper (`packages/core/src/peripheral/`). Place it at "Later, as plugins: the phone's computer-use mirror", or retire it.
10. **Internal job roles** (`reviewer.model`, `titles.model`, `pins.dream`, `pins.cleaner`). Place them at "the safety reviewer behind" (B8).
11. **The provider conformance suite** (`@yanlinglabs/winter-provider-conformance`). Place it at "prints a folder's class, contributions", as the test kit for model plugins.
12. **Smaller features:**
    - the subagent stall watchdog (§9.3)
    - switching model mid-session (§6.3)
    - plan alarms and usage's "numbers only" rule (§12)
    - update channels and the idle gate (§12, release)
    - `winter doctor` (§5.8)
    - the Norma migrations (retire them)
    - a dev identity, `com.waifucave.wyrmhole.dev` (§2)

## F. Wording and clarity

- Every `§14.2 Q<n>` (e.g. "§14.2 Q5") → "§14.2 item <n>".
- "connected to the device doing the thinking" → "connected to the computer running the bot".
- "During a takeover,** the device in use writes" → "the takeover computer writes".
- "It is one plugin, `mcp__wyrm__ComputerUse`" → "It is one plugin, `wyrm/computer-use`, whose tool `mcp__wyrm__ComputerUse`".
- "become surface plugins" → "become plugins contributing to".
- "Wyrmhole API" and "client API" → "plugin API" everywhere.
- `home/MainDesktop/` → `home/Studio/`, so readers don't take it for "the main".
- The manifest's `agentBackends?: string[];` → `onlyBackends?: string[];`, so it isn't confused with the `agentBackends` point when deciding what counts as code.
- "Every bot has the same tools and sees every installed plugin" → add "scoped to bots (§5.1)".
- "Each bot has an animated VRM avatar" → "Each bot can have an animated avatar, VRM by default".
- "global theme plugins" → "the user's global theme".
- "A plugin gets only its own secrets, through the plugin API" → add "; workers in the shared host are not isolated from each other's memory".
- "no bot or plugin can remove" → "no bot or data plugin can remove; a model plugin sees the whole prompt, and its OK says so".
- "carries over." (§7) → "carries over, computing schedules in the routine's time zone; Winter uses the host's local time".
- "a short word check" → "its 4-word check, which Winter already has".
- "screen control outside the bot's own windows" → "…outside windows and tabs the bot opened".
- "a tool becomes callable as `mcp__<plugin>__<Tool>`" → "a tool becomes callable (`Glob`, `Grep` or `mcp__<plugin>__<Tool>`)".
- "Wrappers are named `mcp-<server>`" → add "with the server name lowercased, and `_`, `.` and spaces turned into `-`".
- "then **opensky**" → name its tools: `mcp__opensky__…`, or `mcp__wyrm__…` if it is a child of `wyrm`.
- "W4's device registry" → say how it differs from W5's computer registry.

No repo file was created, edited or moved. The `final-review/` scratch folder was never needed, so there was nothing to delete. The web-check agent's tooling saved two oversized page fetches in this session's own `tool-results` folder under `~/.claude/projects/…`; nothing else there was touched.
