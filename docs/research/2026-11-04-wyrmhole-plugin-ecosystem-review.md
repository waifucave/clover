# Wyrmhole spec: plugin-ecosystem review of revision 13

Reviewer: a third Opus reviewer, read-only, November 4, 2026, asked by the owner for a full review of the plugin ecosystem: whether extension points are open-ended or a type list in disguise, the minimal core, plugin-declared points and the plugin API, the lifecycle, UI composition and day-one developer experience. It had the spec, the [plugin model proposals](2026-11-03-wyrmhole-plugin-model-proposals.md), both earlier reviews and Winter's code.

Status: received November 4, 2026, and applied the same day as spec revision 14: sections A, B (as [P] defaults), E and F, with M's rule for a new core point; T and D checked. The owner's answers to section C, all as recommended, are spec items 64–68: C1, commands by name; C2, the base theme everywhere; C3, MCP Apps in 1.111.1; C4, declared hosts enforced for UI code, with isolated web views and host code left open, as the question said (the review's option also covered web views); C5, language packs. A3 first landed as a point the Claude Code backend declares; the owner then ruled that every plugin is Wyrmhole-shaped, so a Claude Code plugin folder is wrapped when it is added and nothing loads one natively (item 69). The owner then added items 70 and 71: a plugin can restyle one part in place or hide it, and a plugin may run add-ons of its own, in its own format, that Wyrmhole doesn't manage, with guards (a manifest flag, a warning in the OK, a data folder closed to bots, and a sealed card before a bot-supplied add-on loads); no earlier review had raised add-ons a plugin manages itself. Checked against the code and the sources, and confirmed: adapters hold a credential store today (`ProviderContext.credentials`, `winter-agent-sdk/packages/provider-runtime/src/types.ts:500`); the conformance kit is `@yanlinglabs/winter-provider-conformance` 0.0.62; Winter's manifest has `contributes.shortcuts` and `tile` (`packages/core/src/agent/plugin-manifest.ts:32`; a tile is a title and a value the plugin pushes); MCP 2026-07-28 has no `initialize` handshake, `server/discover` returns `instructions`, tool names may contain `.`, and `list_changed` needs `subscriptions/listen`. Changed while applying: B1 tells a UI spot from a data point by `props` in its declaration, and the format `command` became `program`, so it can't be confused with commands; B2's hook returns went into §5.3, with hooks on one event running in turn by plugin id, its `call:` bullet landed with C1, the composer's `/` list was left out, `host.on` lets a host half talk to its components, and a table now defines every capability; B4 keeps theme and `ui` ids unique within their plugin (`<plugin-id>#<theme-id>` elsewhere) and puts the dot rule for MCP tool names in §6.7; B7 also limits `${secret:…}` to the plugin's own secrets, since a bot could otherwise edit an approved wrapper's headers to send another plugin's key; B9's cleaner became an allow list of at-rules, and its first sentence landed with C2; B12's `--` rule covers every id in a path or origin; M's catalog also gains `file.preview` and `avatar.packs`; F9 adds a namespace rule; F10 keeps helper permissions a closed list, since the OK names each one plainly; and §12 maps Winter's `shortcuts` and `tile`.

---

**Verdict: not ready.** The list of core points holds up: all 15 daemon points pass the spec's own test in §5.3. The rest of the ecosystem can't be built from the spec without guessing, and three rules are type lists in disguise. As the last review found, W1 still has to invent the plugin API's calls and events. W2 likewise has to invent how spots work across layers.

Fix these first:
1. **A10, a security gap.** A manifest edit that changes what runs, such as a `stdio` server's `args`, counts as a data edit, so it applies with no OK. The plugins folder isn't fenced, so a bot can make that edit.
2. **B1–B3.** Let any part declare a typed point, specify the plugin API, and make start and placement rules generic.
3. **A5, A7, A8.** Card styling, placement and the data/web/code rule should stop naming specific points.
4. **A1, A2, A6.** Revision 13's no-jail decision for Windows and Linux hasn't reached §1.1 or §5.6. Giving each plugin tree one layer breaks the bot-tab [D].
5. **B4, B5.** Lifecycle details, and the index with its revocation list.

Then answer C1–C5.

## T. The types test

| # | Idea | Contributions | Fits today? | Core special case | Decided by |
|:-|:-|:-|:-|:-|:-|
| 1 | Bot with its own tab look; pack of bots | `bot`, `themes`, layout, `ui`; children | Yes | one bot per plugin; own-tab wall; user layer; no opt-out on main-capable devices | §5.1, §5.5, §6.1; `pack/luna` in paths unspecified (B12) |
| 2 | Whole-app theme | `themes` | Yes | base, global and bot stack; CSS cleaner; `card.*` OK | §5.5; default global theme and theme-id scope unspecified |
| 3 | Composer replacement | `ui` → `composer` + `declares` | Yes | smaller part wins; must re-declare child spots | §5.5 |
| 4 | Shell replacement | `ui` → `app.root` | Yes | safe mode; `wyrm` keeps its layer | §5.5, §5.8 |
| 5 | Model provider | `models` + `host`, or `endpoint` only | Yes, API gap | daemon adds keys; conformance suite; OK says it sees the whole prompt | §3.3, §5.2; the keyed request call unspecified (B7) |
| 6 | MCP server; browser tool | `mcpServers`; `browser` | Yes | wrappers; `computer`/`saveTo`; `npx` flag | §5.1, §6.7, §9.1, §12.1 |
| 7 | Skill; agent definition | `skills`, `agents` | Yes | Glossary; scripts run under Bash | §5.3, §6.8, §9.3 |
| 8 | Hook | `hooks` | Partly | order; can't skip approvals | §5.3; what each event may return unspecified |
| 9 | Schedule, webhook and Slack triggers; forwarder | `triggers` (+`declares`), `webhook.ingress` | Yes | placement table names `webhook.ingress` (A7) | §5.4, §7 |
| 10 | Voice | `voices` | Yes | runs where the user talks | §6.6 |
| 11 | Relay | `relays` | Partly | `runsOn: "chosen"` undefined | §5.2, §5.9 |
| 12 | Notifier | `notifiers` | Yes | desktop notifications named in placement (A7) | §5.2, §10 |
| 13 | Companion | `companions` | Yes | fixed remote list; never sees cards | §10 |
| 14 | Computer-use backend | `mcpServers` (`perComputer`) + `helper` | Partly | holds and window positions come "through the plugin API" with no capability (B10) | §5.5, §9.2 |
| 15 | Cloud computer and provider | `computer`, `computerProviders` | Yes | creating and deleting always ask | §9.2 |
| 16 | Agent backend (ACP or cloud) | `agentBackends` | Yes | own sandbox with the deny list, or an OK | §9.3 |
| 17 | Command | `commands` | Partly | where it shows, `args` format; §3.2's "namespaced methods" (A9) | §5.3 |
| 18 | Sidebar app, panel, web page | `ui` → `sidebar.app`, `panel`, `web` | Yes | partitions not namespaced | §5.5, §11 |
| 19 | Island tab; pill target | `ui` → `island.tab`, `pill.target` | Partly | the pill's fields unstated; a non-bot target needs a handler | §5.4 |
| 20 | Avatar renderer (Live2D) | `ui` → `app.avatar`, key `live2d` | Yes | needn't be a core point (M); lip-sync feed unspecified | §5.3, §10 |
| 21 | Speech-to-text from a different plugin than the voice | `voices` (`listen`) | Partly | `bot.voice` names one provider for both directions | unspecified |
| 22 | Image generation | `mcpServers` | Yes | files saved through `saveTo` | §9.1 |
| 23 | Memory backend | `mcpServers` + `hooks` | Partly | storage is core (§5.8); what `turn.start` may add is unspecified | §5.8 |
| 24 | Calendar or email connector with its own UI | `mcpServers`, `ui`, `triggers`, `settings` | Partly | OAuth sign-in exists only on models, voices and providers | unspecified |
| 25 | File previewer for a new format | a point the file view declares | No: spot missing | — | unspecified |
| 26 | Status-bar item | a shell spot | No: spot missing | — | unspecified |
| 27 | Context-menu item | a menu spot per part | No: spot missing | the core draws menus that cross layers | §5.5 covers that drawing only |
| 28 | Keyboard shortcut | a field on `commands` | No: field missing | the main process binds keys; Winter has `contributes.shortcuts` today | unspecified |
| 29 | A plugin's own settings page | `settings`, `settings.section` | Yes | — | §5.1, §5.5 |
| 30 | Long-running background service | `host` alone | No: never starts | — | §5.2: a host half starts "only when one of its contributions runs there" |
| 31 | API other plugins use | `call:<plugin-id>` | No: no calls defined | — | a §5.9 comment only |
| 32 | Message translation | `ui` → `conversation.message` `bot` | Partly | replace-only, so it takes over the bot's own bubble | §5.5 |
| 33 | Usage dashboard | `ui` + `usage.read` | Yes | — | §5.8 |
| 34 | Mini-game in the sidebar | `ui` + `client` or `web` | Partly | no plugin storage | unspecified |
| 35 | Avatar or sound pack | data files | No: point missing | — | unspecified |
| 36 | Localization pack | — | No: needs a core point | the core draws its own text (cards, welcome guide) | unspecified (C5) |
| 37 | Log viewer | `ui` | No: no log access | — | unspecified |
| 38 | New approval-card design | `ui` → `approval`, `card.*` tokens | Partly | cards shown elsewhere escape the styling OK (A5) | §5.5 |
| 39 | Routine pack (e.g. the dreamer) | `skills`; the bot writes it with `Routine` | Yes | — | §7, §14.2 item 12 |
| 40 | MCP App UI | `mcpServers` + `ui://` | No: needs a core feature | the core is the MCP client | unspecified (C3) |

Rows 1–20 are ideas the spec names; 21–40 are ideas it never mentions.

**Conclusion.** Points are open-ended in design, not yet in fact.
- **Named ideas:** 15 of 20 fit and 5 fit partly, because the core points were cut to fit them.
- **Unnamed ideas:** only 4 of 20 fit and 10 can't be built.

The cause is not the core list. Three things make it a type list in disguise:
1. Only `ui` entries and triggers can declare points, so any new non-UI hub would have to become core point 16.
2. The data/web/code rule, the placement table and the card-styling rule each name points.
3. There is no mechanism for calls between plugins, for storage, or for starting a host half on its own.

With B1–B3, B7 and B8, 15 of the 20 unnamed ideas need no core change. The other 5 (a separate listening provider, shortcuts, core text, log access, MCP Apps) need the core because it owns those things: the `bot` point, the main process, its own text, its logs and the MCP client. That is §5.3's test working as intended.

## M. The minimal core

**The closed set:**
- **15 daemon points:** `bot`, `models`, `mcpServers`, `skills`, `agents`, `agentBackends`, `hooks`, `commands`, `triggers`, `voices`, `computerProviders`, `computer`, `relays`, `notifiers`, `companions`.
- **4 app points:** `themes`, `app.root`, `app.surface`, `bot.tab`, plus `locales` if C5 is (a).

A named core part reads or calls each of them.

**How today's list maps:**
- **Keep:** the 15 daemon points. Each has a core consumer: the turn loop, tool dispatch, Glossary, `Agent`, the routine engine, the computer registry, the link layer and the remote-call list. Also keep `themes` (the theme engine), `app.root` (the app mounts it) and `app.surface` (only the main process opens windows).
- **Don't merge `relays`, `notifiers` and `companions`.** They already share `Service`; one point with a role field would be a kind under another name.
- **Widen `commands`:** it becomes the plugin's public API (B2), with `key` and `runsOn` fields.
- **Promote `bot.tab`.** Five core rules depend on it today: the bot wall, a layer per bot tab, the base theme, `when.bot` and the smaller-part measure.
- **Make `app.avatar` plugin-declared:** a keyed spot `avatar`, declared by whatever fills `bot.stage`. The core never calls it, and a keyed spot already picks by format.
- **Catalog spots stay plugin-declared** by `wyrm` children, with the names published by the plugin SDK: `sidebar`, `sidebar.bot`, `sidebar.app`, `main`, `panel`, `panel.view`, `settings.section`, `bot.header`, `bot.stage`, `bot.side`, `conversation`, `composer`, `composer.action`, `conversation.message`, `tool.result`, `island.tab`, `pill.target`, and the non-UI `webhook.ingress`. B8's add-on and menu spots join them with no core change.

**Rules that name one point or plugin:**
- **Keep** (each serves a core consumer or a [D]):
  - `wyrm` and `alpha` as read-only roots; `wyrm`'s namespace, shared layer, settings-writing layer and safe mode.
  - One bot per plugin, the tab wall and the user layer.
  - No opt-out for plugins with a bot or models on main-capable devices, and keys added by the daemon.
  - `mcpServers` naming, `computer`/`saveTo` and the 4 KB instructions cap.
  - Hook order, the `computer` creation and deletion cards, the companions' fixed list, and sealed frames.
- **Make generic:** the data/web/code rule (A8), placement of `webhook.ingress` and desktop notifications (A7), the `approval` cell as card styling (A5), computer-use duties (B10), and what `call:` calls (B2).

**Rule for a new core point.** Add after "The test for a core point: it exists only where the core itself reads or calls what is contributed.":

> **[P]** So the core gains a point only when one of its own parts must read or call the contribution where the plugin API can't reach: the turn loop, tool dispatch, the routine engine, the link layer, the remote-call list, the computer registry, the credential store, or the app's main process, theme engine and sealed frames. Everything else is a plugin-declared point. A new core point is a minor version of the plugin API, and no core rule names a plugin-declared point, or a plugin other than the roots `wyrm` and `alpha`.

## A. Contradictions and errors

**A1. §1.1 contradicts revision 13.**
- Old: "The core keeps them away only from the secret store, the daemon's socket and other plugins' UI (§5.2, §5.5, §5.6)."
- New: "The core keeps them away only from other plugins' UI, and on macOS from Wyrmhole's Keychain items and the daemon's socket (§5.2, §5.5, §5.6)."

**A2. §5.6 says the same.**
- Old: "It is **not** a containment boundary: apart from the secret store and the daemon's socket, a host plugin can do anything the user can."
- New: "It is **not** a containment boundary: a host plugin can do anything the user can, except, on macOS, reach Wyrmhole's Keychain items and the daemon's socket."
- Old: "**[P]** A full OS sandbox for plugins, beyond the secret store and the daemon's socket, can come later."
- New: "**[P]** A full OS sandbox for plugins can come later; until then only macOS keeps host halves from Wyrmhole's Keychain items and the daemon's socket."

**A3. §9.3's Claude Code row can't be reached.** §5.1 and §12 put Claude-format plugins later, and no manifest field can carry one.
- Old: "| Claude Code plugins, including mods and hooks | Only on Claude Code | Loaded natively (`--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS`) |"
- New: "| Claude Code plugins, including mods and hooks | Only on Claude Code | A plugin contributes its Claude Code plugin folder to `claude-code.plugin`, a point the Claude Code backend declares; its `dir` field has the format `code`, so the plugin is code. The backend loads each folder with `--plugin-dir`. Installing Claude-format plugins themselves waits for §12 |"

**A4. "Exists" has two readings.** Settings would show "waiting" whenever the settings screen or panel is closed.
- Old: "A UI spot exists only while the component that declares it is on screen, so several can exist at once, such as two windows that each have a `composer`."
- New: "A UI spot exists while the entry that declares it is active, and waiting and Settings go by that; it is mounted only while that entry's component is on screen, so several can be mounted at once, such as two windows that each have a `composer`."

**A5. Card styling is narrower than "any plugin that does".** Cards also show in the island and the pill. An island tab that places sealed frames gets no "restyles approval cards" warning, and its later changes don't wait for an OK.
- Old: "**[P]** Card styling is the entry that dresses the `approval` cell plus the token values handed to the sealed frames; no other CSS reaches inside an approval card."
- New: "**[P]** Card styling is every component that places sealed frames, wherever it shows them (the `approval` cell, an island tab, the pill), plus the token values handed to the frames. A component receives sealed frames only if its plugin lists the `approvals` capability, so the OK can say so before anything runs, and no other CSS reaches inside an approval card."
- Old: "Sealed frames take only `card.*` tokens, so card styling is that set plus the `approval` entry."
- New: "Sealed frames take only `card.*` tokens, so card styling is that set plus the components that place sealed frames."

**A6. One layer per tree breaks the [D] "only its own tab".** A [D] lets a bot's child add a panel to every tab. If the child shares the bot's layer and origin, the bot's code can reach that panel in other tabs, through shared storage or BroadcastChannel.
- Old: "Every plugin tree with UI code gets its own layer."
- New: "Every plugin with UI code gets its own layer and origin, a child included (its origin writes the child's `/` as `--`), so a bot's components never share a process with what its children add to other tabs."
- Cost: one more renderer per code child, which sleeps while hidden.

**A7. Placement names a plugin point** (the core-point test says it shouldn't).
- Old: "| `triggers`, `webhook.ingress` | each computer, started at once |"
- New: "| `triggers` | each computer, started at once |"
- After "| UI | every app instance |" add: "| Entries for a plugin-declared point | wherever the declaring contribution runs |"
- Old: "| `computerProviders`, `notifiers`, `companions`, `commands` | the main, or the takeover computer while the main is offline (desktop notifications run on each computer) |"
- New: "| `computerProviders`, `notifiers`, `companions`, `commands` | the main, or the takeover computer while the main is offline, unless the entry's `runsOn` says otherwise (desktop notifications say `each`) |"

**A8. The data/web/code rule lists nine points.** It can't classify a contribution to a plugin's point, and nothing says where network hosts come from.
- Old: "* **Code:** the plugin has a `host`, `client` or `helper` part; or an MCP server of type `host` or `stdio`; or any `hooks`, `commands`, `triggers`, `voices`, `computerProviders`, `relays`, `notifiers`, `companions` or `agentBackends`; or a model with an adapter or its own sign-in code; or a UI component."
- New: "* **Code:** the plugin has a `host`, `client` or `helper` part, or a field that names something to run: a `stdio` server, a hook's or agent backend's `command`, or a point field with the format `command` or `code` (§5.4). Every handler, adapter, custom sign-in and component lives in `host` or `client`, so this rule names no point."
- Old: "The network hosts a plugin talks to are listed separately, whatever its class."
- New: "The network hosts a plugin talks to are listed separately, whatever its class: its `network:` capabilities plus the host of every field with the format `url` (an `http` server's `url`, `endpoint.baseUrl`, `auth` URLs, `web.url`)."

**A9. "Namespaced methods" has no mechanism.**
- Old: "Every RPC method and event; plugins add namespaced methods but cannot change core ones"
- New: "Every RPC method and event; plugins add methods only as `commands`, named `<namespace>.<name>` (§5.3), and cannot change core ones"

**A10. A manifest edit that changes what runs counts as data.** `wyrmhole.json` is JSON, so it's data under §5.3. The rule is "A code change asks again", yet changing the `args` of an already-OK'd `mcp-blender` hits no trigger and applies at once.
- Old: "A local edit asks again on the same triggers."
- New: "A local edit asks again on the same triggers, and any edit that changes what runs is a code change wherever it is written: a `stdio` server's `command`, `args` or `env`, a hook's or agent backend's `command` or `args`, `host`, `client` or `helper`, or a field with the format `command` or `code`."

## B. Gaps that would block a phase

**B1 (W1). Only `ui` entries and triggers can declare points**, so a host-only service can't declare one, and `fields` has no format.

After "A `private` point is open only to the declaring plugin's own tree.":

> **[P]** `declares` may sit on any contribution or on the `host` part; a point the host declares exists while the host half runs, and is filled with a top-level dotted key. Only an entry with a `component` declares a spot. A point's `fields` (what each entry writes) and `props` (what a spot hands each component) are JSON Schemas. The formats `path`, `url`, `handler`, `component`, `command` and `code` tell the core what a value is. Entries are checked when their point appears, and one that fails waits with the reason. A non-UI point has one active declarer; a second one waits ("declared by …") until the user picks between them. A plugin that declares a well-known name must use the catalog's schema, or it is refused. Points change only compatibly: new fields are optional, a breaking change is a new name (`luna.cards2`), and `deprecated` marks the old one in Settings, `validate` and Glossary.

**B2 (W1, W2). The plugin API has capabilities but no calls**, so W1 would invent them.

After "Contributions start as their points appear, and stop before the plugin they depend on does.":

> **[P] The plugin API.** Every host half and component gets one object from the plugin SDK, and nothing in it names a kind of plugin:
> * **Points:** the declarer reads entries (`points.entries`, with paths turned into asset URLs), hears changes (`points.watch`) and calls an entry's handler (`points.call`). The handler runs in the contributor's worker, where the declarer runs. A plugin's events are points too: listeners contribute handlers, and the declarer calls them.
> * **Commands:** a command is the plugin's public function, named `<namespace>.<name>`, with a JSON Schema for `args` and JSON results. It can be run from the app (the palette, buttons, the composer's `/` list), from the CLI (`wyrmhole run`), from the iOS app, or by another plugin that has `call:<plugin-id>`, which the OK lists. A call to a missing plugin fails with "not installed" and never makes the caller wait. A command's `key` is a default shortcut the app binds while a Wyrmhole window has focus, and the user can rebind it.
> * **Own host:** a component calls its own plugin's handlers (`host(name, args)`). The call runs on the component's computer if the host half runs there, and on the main otherwise.
> * **Storage:** each plugin gets a data folder on each computer (`<home>/plugin-data/<id>/`, `${data}` in `stdio` args), never synced and kept on removal. It also gets a synced store of up to 1 MB. Neither sits in the plugin folder, so neither changes its hash.
> * **Capabilities:** each one in §5.9 stands for a fixed set of calls and live events, listed in the SDK's API reference and versioned with `engines.wyrmhole`.
> * **Hooks:** `tool.before` may deny, ask or replace the input. `tool.after` may replace the result. `message.in` may replace the user's text before the model sees it, and `message.out` the bot's text before it is stored and shown. `turn.start` may add a labelled note. `turn.end` and `compact.*` only observe.
> * **Limits:** calls take structured-clone arguments and time out after 10 s by default (a handler may declare up to 10 minutes). A call to a stopped plugin fails at once with its reason. A hook that throws or times out is skipped, and Settings shows it.

**B3 (W1). Background services never start, and `runsOn` is undefined.**

After "A plugin's host half starts on a computer only when one of its contributions runs there.":

> **[P]** `host.start` (`each`, `main` or `chosen`) starts the host half there at once, for a plugin that runs a service of its own. `runsOn` has one meaning on every entry: `each` is every computer, `main` is the main or the takeover computer, and `chosen` is the computers the user ticks, as for local servers (§9.1). With no `runsOn`, an entry runs where the table's row says.

**B4 (W1). Lifecycle rules have two readings or none.**

After "A refused plugin stays off until its folder changes.":

> * **[P] Formats:** the app reads every `manifest`, `theme` and `layout` format it has shipped, and refuses a newer one with "needs a newer Wyrmhole"; `validate --upgrade` rewrites old ones. An unknown undotted key refuses its entry, while a dotted one is a plugin point and waits. A child that fails validation is refused alone; the rest of its tree loads.
> * **[P] Ids:** every id an entry defines (a voice, provider, backend, trigger type, theme or model provider) is unique among enabled plugins. A clash refuses only that entry, and the plugin enabled first in the synced list keeps the id. A reference to another plugin's entry is resolved when used, and a missing one turns off only that feature, with a reason. An MCP tool name with characters model APIs refuse (MCP allows `.`) has each one turned into `-` before the digest rule.
> * **[P] States:** Settings shows each plugin as found, refused, invalid, off, waiting, running, stopped or blocked, with the reason. The registry reads a folder once it has been unchanged for 2 s and its manifest parses.
> * **[P] Crashes:** a crashed worker restarts after 1 s, the delay doubling up to 1 minute. After 3 crashes in 10 minutes, the plugin stops on that computer, its tools answer "plugin stopped: <reason>", and Settings shows its last log lines until the user restarts it. A worker that is silent for 30 s counts as a crash. A folder holding a native module runs in its own process. Logs go to `logs/plugins/<id>.log`, shown in Settings and by `wyrmhole plugin logs`.

**B5 (W1). The index, its revocation list and npm installs are unspecified**, which the last review also flagged.

After "Local plugins change only when their folder does; bundled plugins update with the app.":

> **[P]** An index is a JSON file (`index: 1`) listing ids and versions, each with its tree hash and download URL, signed with the index's key. The official key ships in the app, and another index is added by URL with its key and a warning. The revocation list names an id, with all versions or listed hashes, and a reason. The app checks it at start and every 6 hours. A revoked tree stops on every device, stays on disk marked blocked, and Settings shows why. An npm install unpacks the package as it is: no install scripts run and no dependencies are fetched, so code ships bundled. It updates like an index plugin.

**B6 (W1, W3). Development folders on a non-main computer are undefined.** Bots think on the main, and a development folder never syncs there.

After "While one is on, the tray shows it and lists each reload, and it turns off after 24 hours unless renewed.":

> **[P]** A development folder's contributions exist only on its own computer: a bot in one thinks and shows there, and its models, tools and UI serve only that computer. A development folder with an installed plugin's id replaces that plugin there while it is on.

**B7 (W1). Sign-ins exist only for models, voices and providers, and `network:` gates nothing.** Also, today's adapters read `ProviderContext.credentials` (`winter-agent-sdk/packages/provider-runtime/src/types.ts`), which "adapters never hold a key" removes.

After "a plugin's manifest declares its settings; the default shell shows them, and secret fields go straight to the credential store.":

> **[P]** Any plugin may list `auth` for its own service. The core runs those sign-ins as it does a model's, the refresher refreshes them (§8.5), and the tokens reach the plugin only through the core's fetch. That fetch adds the key or token, and it reaches only `network:` hosts: this is what that capability gates. The SDK's adapter interface swaps its credential store for this fetch, except for an adapter running in its own process (SigV4).

**B8 (W2). Spots across layers have no contract.**

After "A replacement for a container should declare the container's own spots (a new composer declares `composer.action`); otherwise what fills them waits, and Settings says why.":

> **[P]** A component shows a spot with the SDK's `<Spot name key props>`. The core mounts each entry inline in the same layer, or as a frame from another layer. It hands the entry only the declared props (data, plus callbacks the core routes back) and the tab's resolved tokens, which the entry's own CSS may override. A layout's `{ spot }` places spots that the tab's filler or the bot's plugin declares. `prefer` lists `<plugin-id>` or `<plugin-id>#<entry-id>`. In step 4 only `when.bot` ranks entries; other conditions only decide whether an entry applies. The user's bot ticks start from the manifest's `when.bot` and replace it. Entries in a list spot can be hidden and reordered. The catalog gives each part list spots for add-ons (`conversation.message.extra`, `bot.header.action`, a shell `status`, and menus such as `menu.message`), so a plugin can add to a part without replacing it.

**B9 (W2). Item 63 left the app outside bot tabs with no default theme** (see C2). Theme ids and tokens are also unlisted, and the CSS cleaner misses global names.

After "**[P]** Settings picks the base theme, `wyrm`'s by default, as it picks the global theme, and a bot with no theme of its own simply skips step 4.":

> **[P]** Until the user picks a global theme, step 3 is `wyrm`'s base theme too, so the whole app starts from it. Theme ids are unique like other entry ids. The plugin SDK publishes the token catalog (names, types and defaults; `card.*` is the set sealed frames take). The cleaner also drops `@property`, and prefixes `@layer`, `@counter-style` and `@font-palette-values` names with the plugin's id.

**B10 (W5). Holds have no gate**, so either every plugin can take them or the core has to know which plugins do computer use.

After "Computer-use plugins take and release them through the plugin API, which also tells the approval cards when an action is running (§5.5).":

> **[P]** Holds, the user-working mark, Wyrmhole's window positions and the "action running" signal come only with the `computers.control` capability. The OK names it ("controls the screen and input of your computers").

**B11 (W1–W3). Third-party authors have no kit on day one.**

After "Model plugins also get Winter's provider conformance suite (`@yanlinglabs/winter-provider-conformance`, renamed) as their test kit.":

> **[P]** The plugin SDK (`@waifucave/wyrmhole-plugin-sdk`) ships, from one source:
> * JSON Schemas and TypeScript types for the manifest, theme and layout formats
> * the spot, token, hook and capability catalogs
> * `wyrmhole plugin new <template>`, for a bot, theme, tool, UI part, model, trigger or point
> * a bundled skill that teaches bots the same
>
> `validate` checks the schemas and every catalog name, prints the class and the OK's text, takes `--json`, and exits non-zero on any error. The docs are generated from the same catalogs.

**B12 (W3). Bot ids from packs break paths, and voices can't split listening from speaking.**

After "If the user has no key for the default model, the bot uses the user's default model.":

> **[P]** Wherever a bot's id names a file or folder, its `/` is written `--` (`bots/pack--luna/memory/`), which no id can contain. `voice.listen` may name a different plugin for listening. The app records and plays audio and hands it to voice plugins through `audio`, so no plugin needs the microphone permission.

## C. Questions for the owner

**C1. How one plugin calls another.** B2 assumes (a).
- (a) **Recommended:** commands by full name, gated by `call:<plugin-id>` (as with VS Code's `executeCommand`, and Raycast's permission alert), plus points for callbacks. Cost: soft name dependencies.
- (b) Only through points. Cost: every API needs its own declaration.
- (c) Add VS Code-style `exports` objects too. Cost: object proxies across workers, which are the hardest to version.

**C2. The global theme after item 63.**
- (a) **Recommended:** `wyrm`'s base theme is also the default global theme. Cost: it must style the sidebar, settings, island and pill too.
- (b) Only bot tabs get it. Cost: plain chrome around waifu tabs, which falls short of the [D] "The default look is waifu-themed".

**C3. MCP Apps** (stable since January 26, 2026; MCP is on the 1.111.1 floor).
- (a) **Recommended:** in 1.111.1, show a tool's `ui://` page in an isolated view. The core bridges its calls under the same approvals and enforces `_meta.ui.csp`. Cost: a W2 bridge.
- (b) Later, in the core. Cost: those servers show only text until then.

**C4. Declared network hosts.**
- (a) **Recommended:** enforce them for UI code and web views through each plugin origin's session, as Figma enforces declared domains; host halves stay unenforced, and the OK says so. Cost: authors must list every host their UI uses.
- (b) Keep them informational. Cost: the host list in the OK means nothing.

**C5. Localization.**
- (a) **Recommended:** a core point `locales`, keyed by language, holding string tables for core text and for each plugin's own keys; a language pack is then a data plugin. Cost: W2 work, and every `wyrm` string goes through a key.
- (b) English only in 1.111.1. Cost: retrofitting every string later, and approval cards stay in English.

## D. External claims checked

1. **VS Code has 38 core contribution points**, including menus (`editor/context`), keybindings, configuration, views and customEditors. A status-bar item is API-only (`createStatusBarItem`). The list grows every release, which is the cost Wyrmhole avoids only with B1. https://code.visualstudio.com/api/references/contribution-points
2. **VS Code extensions declare points of their own.** The Markdown extension reads `contributes['markdown.markdownItPlugins']` from other extensions and calls `extension.exports?.extendMarkdownIt`; TypeScript reads `typescriptServerPlugins` the same way. That is §5.4's model, and it shows the declarer needs to call into contributors (B2). https://github.com/microsoft/vscode/blob/main/extensions/markdown-language-features/src/markdownExtensions.ts , https://github.com/microsoft/vscode/blob/main/extensions/typescript-language-features/src/tsServer/plugins.ts
3. **VS Code activation:** since 1.74 contributions activate an extension implicitly, and `onStartupFinished` starts it eagerly, the model for B3. `exports` is "The public API exported by this extension (return value of `activate`)", and a missing dependency refuses activation, where Wyrmhole waits. https://code.visualstudio.com/api/references/activation-events , https://code.visualstudio.com/api/references/vscode-api
4. **"The extension host has the same permissions as VS Code itself"**, which supports §5.2's "as in VS Code". https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security
5. **Claude Code plugins:** `name` is the only required key. The fields include `dependencies` (with semver), `userConfig`, `lspServers`, `outputStyles`, `workflows` and an experimental `themes`. `${CLAUDE_PLUGIN_DATA}` gives each plugin a data folder (as in B2). Marketplaces use `.claude-plugin/marketplace.json`, and "`claude plugin validate` is the authoritative check". Mods' `engine.create` adds a namespace that other mods call, so Claude Code has plugin-to-plugin calls. https://code.claude.com/docs/en/plugins-reference , https://code.claude.com/docs/en/plugins/mods/reference.md
6. **Chrome:** "When a new permission that triggers a warning is added, the extension will be disabled until the user accepts", which matches §5.6's triggers. https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings
7. **Obsidian's manifest has no UI fields.** The ribbon, status bar, commands, settings tabs and `registerExtensions` are all code calls, and "Obsidian cannot reliably restrict plugins to specific permissions". https://docs.obsidian.md/Reference/TypeScript+API/Plugin , https://obsidian.md/help/plugin-security
8. **Raycast:** commands run as view, no-view or menu-bar. Preference types include file, directory and appPicker. A `launchCommand` into another extension shows "a permission alert". https://developers.raycast.com/information/manifest , https://developers.raycast.com/api-reference/command
9. **Figma:** "Figma enforces the list of domains that you gave for `allowedDomains`". Plugin code runs in a sandbox without the DOM, and the UI is an iframe that talks by message passing. https://developers.figma.com/docs/plugins/manifest/ , https://developers.figma.com/docs/plugins/making-network-requests/
10. **MCP 2026-07-28** has "no negotiation handshake"; `instructions` now come from `server/discover`. Tool names SHOULD be 1–128 characters and may contain `.`, and `list_changed` needs a `subscriptions/listen` stream (F8, B4). https://modelcontextprotocol.io/specification/2026-07-28/server/tools
11. **MCP Apps:** SEP-1865, "Stable (2026-01-26)", identified as `io.modelcontextprotocol/ui`. A tool points at a `ui://` page with `_meta.ui.resourceUri`, the page talks JSON-RPC over postMessage, and hosts "MUST NOT allow undeclared domains". https://modelcontextprotocol.io/extensions/apps/overview , https://github.com/modelcontextprotocol/ext-apps
12. **CSS:**
    - Layout containment "establishes … a fixed positioning containing block", so `contain: layout paint` holds.
    - `@property` registrations share "a single global registration map for the Document".
    - `@counter-style` names are global.
    - `@layer` names are per tree, so a theme injected into the `wyrm` layer can reorder the shell's layers (B9).

    https://www.w3.org/TR/css-contain-2/ , https://drafts.css-houdini.org/css-properties-values-api-1/ , https://drafts.csswg.org/css-cascade-5/
13. **Electron `before-mouse-event`** (added in 36.5.0) shows the main process every click before the page, a natural place for §5.5's hardware check. Reading the event's source process still needs a native add-on. https://www.electronjs.org/docs/latest/api/web-contents , https://releases.electronjs.org/release/v36.5.0
14. **In the repo:** Winter's `winter-plugin.json` declares `contributes.shortcuts` and `tile` (`packages/core/src/agent/plugin-manifest.ts`; `shortcut.register` and `tile.update` in the protocol), and §12 places neither. The conformance package exists (`winter-agent-sdk/packages/provider-conformance`, version 0.0.62).

## E. Items from the last two reviews that didn't land, or landed wrong

- **The default global theme.** The final review's A13 kept `wyrm`'s waifu theme as the global default. Item 63 replaced it with a base theme for bot tabs only, and nothing took over the global default (B9, C2).
- **`declares` on host parts.** The final review's A15 noted that "the schema has `declares` only on triggers and `ui`". Only its naming fix landed (B1).
- **Claude Code plugins.** The final review's E8 landed in §12, but §9.3 still loads Claude Code plugins natively (A3).
- **Holds.** The final review's B13 landed with no capability gating it (B10).
- **The plugin API and the revocation list.** The second review said W1 would have to invent "the plugin API's calls and events, the index's signed revocation list". Neither has landed (B2, B5).
- **The smaller-part measure.** The second review's B7 landed, but "its plugin" can mean the child or the whole tree (F7).
- **The CSS cleaner.** The second review's B6 cleaner covers `@keyframes` and `@font-face` only (B9).
- **Model C items that never carried over:** one declarer per non-UI point; refusing the later of two clashing contributions; a definition for `runsOn` (its `added` value became an undefined `chosen`); network hosts taken from URL fields; hiding and reordering list entries; the found and invalid states (B1, B3, B4, A8, B8).
- **Dropped on purpose, and fine:** the second review's sentence about `stdio` servers in the macOS sandbox went with the jail. The Keychain's access list and the socket's tokens still fence those processes.

## F. Wording

1. Two SDKs share a name.
   - Old: "and the SDK's catalog lists each one's shape, fields and props:" → New: "and the plugin SDK's catalog (`@waifucave/wyrmhole-plugin-sdk`, §12) lists each one's shape, fields and props:"
   - Old: "The well-known names the SDK publishes, such as `composer` or `island.tab`, are exempt." → New: "The well-known names the plugin SDK publishes, such as `composer`, `island.tab`, `webhook.ingress` or `claude-code.plugin`, are exempt."
2. Old: "* A bot's tab declares `bot.tab`, which holds `bot.header`, `bot.stage` (the avatar), `bot.side`, `conversation`, `composer` and `composer.action` (keyed by action id, so one button can be dressed on its own)." → New: "* A bot's tab declares `bot.tab`, which holds `bot.header`, `bot.stage` (the avatar), `bot.side`, `conversation` and `composer`; the composer declares `composer.action` (keyed by action id, so one button can be dressed on its own)."
3. Old: "always-on-top windows opened through the plugin API" → New: "always-on-top windows that the app opens from their `app.surface` entries"
4. Old: "W1 and W2 can run in parallel once the protocol and plugin manifest are pinned." → New: "W1 and W2 can run in parallel once the protocol, the plugin manifest and the plugin API with its catalogs are pinned."
5. Old: "plugin folders with child plugins, the manifest and `wyrmhole plugin validate`," → New: "plugin folders with child plugins, the manifest, the plugin API, development folders, the wrappers for MCP configs, skills and agent files, and `wyrmhole plugin validate`,"
6. Old: `interface Service { id: string; name?: Text; handler: string; runsOn?: "each" | "main" | "chosen" }` → New: the same line, followed by `// runsOn as in §5.2`
7. Old: "The part an entry dresses is the smallest spot holding all its plugin's entries in that tab:" → New: "The part an entry dresses is the smallest spot holding all its plugin's entries in that tab, a child counting as its own plugin:"
8. Old: "The instructions every enabled MCP server sends when it connects are always included, whether its tools are preloaded or on-demand, in a harness-owned block." → New: "The instructions every enabled MCP server gives (in `initialize`, or from `server/discover` under MCP 2026-07-28) are always included, whether its tools are preloaded or on-demand, in a harness-owned block."
9. Old: "with the server's name lowercased and `_`, `.` and spaces turned into `-`," → New: "with the server's name lowercased, each run of characters other than `a-z` and `0-9` turned into one `-`, leading digits and hyphens dropped, cut to fit 40 characters, and a number added on a clash or for `wyrm`,"
10. Manifest schema lines:
    - `interface PointDecl { shape: "single" | "list" | "keyed"; fields?: object; context?: string[]; private?: boolean; doc?: Text }` → `interface PointDecl { shape: "single" | "list" | "keyed"; fields?: JsonSchema; props?: JsonSchema; context?: string[]; private?: boolean; deprecated?: Text; doc?: Text }`
    - `host?: { entry: Path; runtime?: "bun" | "node" };` → `host?: { entry: Path; runtime?: "bun" | "node"; start?: "each" | "main" | "chosen"; declares?: Record<string, PointDecl> };`
    - `commands?: { name: string; description: Text; args?: object; handler: string }[];` → `commands?: { name: string; description: Text; args?: JsonSchema; handler: string; key?: string; runsOn?: "each" | "main" | "chosen" }[];`
    - `settings?: Record<string, Setting>;` → `settings?: Record<string, Setting>;  auth?: Auth[];`
    - `voice?: { provider: string; voice: string; model?: string };` → `voice?: { provider: string; voice: string; model?: string; listen?: { provider: string; model?: string } };`
    - `web?: { url?: string; entry?: Path; partition: string };` → the same line, followed by `// the partition is prefixed with the plugin's id`
    - `permissions?: ("accessibility" | "screen-recording" | "input-monitoring" | "microphone" | "camera")[];` → `permissions?: string[];   // OS permission names, shown in the OK`
    - `// computers.read, files, browser, usage.read, notify, audio,` → `// computers.read, computers.control, approvals, logs.read, files, browser, usage.read, notify, audio,`
11. Old: "An update asks again if it turns data into code, or adds capabilities, network hosts, helper permissions, code children or adult content." → New: "An update asks again if it turns data into code, or adds capabilities, network hosts, helper permissions, hook events, a `stdio` command that fetches code at run time, code children or adult content."
12. Old: "A point is declared in the `declares` field of one of the plugin's contributions, with its shape (`single`, `list` or `keyed`), its fields and a short description." → New: "A point is declared in a `declares` field, on a contribution or on the `host` part, with its shape (`single`, `list` or `keyed`), its fields and props as JSON Schemas, and a short description."

A read-only script confirmed that all 48 Old quotes and placement sentences above occur exactly once in `~/Xcode progects/Norma v2/docs/wyrmhole-spec.md`. No repo file was changed, and I deleted only my own `review-r13-plugins/` scratch folder.
