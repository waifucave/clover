# Wyrmhole spec: check of revision 14

Reviewer: a fresh read-only Opus reviewer, November 4, 2026, asked by the owner to check the text revision 14 added (the plugin API, point schemas, capabilities, the lifecycle, MCP Apps, translations and items 64–71): rules with two readings, contradictions, anything that still names a point, the manifest against the prose, the security invariants, what W1 and W2 would still have to invent, and the outside claims.

Status: received November 4, 2026, and applied the same day as spec revision 15: sections A (except A4, missed by mistake and applied in revision 16), B (as [P] defaults) and F. Checked against the sources and confirmed: Claude Code's command hooks default to 600 seconds, exit code 2 blocks, and a PreToolUse `allow` lets a call through; MCP Apps' bridge methods (`ui/message`, `ui/update-model-context`, `ui/open-link`, `ui/request-display-mode`), its `visibility` rules and its `permissions`; the spec's own §9.1 says `stdio` servers can write the fenced files; Winter's tile is `{title, value?, icon?, progress?, actions?}`. Changed while applying: A8 keeps plugins' data folders readable and only fenced from writes, as the rest of the fenced set is, so "closed to bots' tools" became "fenced from bots' writes"; B1's `settings.set` changes a plugin's own values directly instead of through a sealed card, since only that plugin's code can call it; B4 leaves a folder with only `.mcp.json` to the per-server wrapper; A14's list of core parts also names the app's plugin runtime; and B8's placement replaced "the conversation view" in item 66's paragraph. The owner answered C1 as recommended, which is spec item 72: only trusted packs (the built-in tables, `wyrm`'s packs and packs whose tree hash matches the official index) translate sealed cards and the OK.

---

**Verdict: not ready to freeze.** Most revision-14 text holds: the plugin API names no kind of plugin, any part can declare a point, and the review's deliberate departures work, apart from A1 and A6. Fix first:
1. **Translations can rewrite sealed cards and the OK (C1, A4).** Any language pack, a data plugin, may supply card strings, and the OK for a found plugin is a sealed card. A bot can edit an installed pack, and the edit applies at once as data.
2. **Hooks placed in Claude Code's settings can approve that agent's calls (A1),** against the [D] that hooks never skip approvals.
3. **The add-on guard (item 71) has no means (A2):** no handler learns its caller, and `stdio` servers can still write the data folder.
4. **The OK can stop being true (A3, A5):** class and hosts come from schemas that can appear later, and spot props hand out conversation data without `conversation.read`.
5. **W1 must still invent the keyed fetch, the tree hash, the W1 handler contracts and most of the Claude Code wrapper (B1–B4), which no phase builds (A9).**

The manifest matches the prose for every field the brief lists, except the index and revocation formats, `PointDecl.context` and the `oauth-pkce` fields a non-model sign-in needs (B2, B10). Terms are consistent except "refused" (A11), secrets (A7) and child locale keys (B9).

**A. Contradictions and errors**

A1. Placed hooks can approve (§9.3, against §5.3's [D]). In Claude Code a `PreToolUse` `allow` skips the permission prompt, which under ACP is the request §9.3 routes to our cards. No decision covers this row of a [D] table, and a placed hook can run twice on bridge calls.
- Old: "a hook with a `command` is also placed in Claude Code's own settings, as skills are placed in its skills folder"
- New: "**[P]** a hook with a `command` is also placed in Claude Code's own settings for Claude Code's own tools, as skills are placed in its skills folder, through Wyrmhole's shim, which passes its deny and ask and drops an allow (§5.3)"

A2. The add-on guard has no means (§5.4). No call names a handler's caller, and §9.1 says `stdio` servers "can write these files", so "bots' tools can't write" fails for a bot's MCP tools.
- Old: "which bots' tools can't write, and one with code that a bot or another plugin supplies loads only after the user says yes to the plugin's `confirm`."
- New: "which bots' tools can't reach (§9.1). Since a `stdio` server can still write there, the plugin loads an add-on with code only if its hash is in its synced store, written after the user's own action, or after their yes to its `confirm` when the caller (§5.4) was a bot or another plugin."

A3. The OK can go stale (against §5.6's "The OK shows what a plugin is"): whether an entry names a program, code or a host depends on a schema that may arrive later, and a bot can flip a setting `default` at once.
- Old: "one that fails is invalid, with the reason, and the rest of the plugin runs."
- New: "… runs. When a point appears, or its declarer's update changes the schema, and an entry's values then name a program, code or a host the OK didn't list, that entry waits for a new OK, as an update adding them would (§5.6)."
- Old: "or a field whose format is `program` or `code`. Other data edits"
- New: "or a field whose format is `program` or `code`, and a changed setting `default` waits for the user's OK too, since bots can't change settings (§9.1). Other data edits"

A4. A bot's plugin can translate the whole app, against the [D] "Everything a bot's plugin adds to the UI applies inside that bot's tab": its `locales` can carry `wyrm.` keys.
- Old: "a bot's plugin fills only spots in its own tab;"
- New: "a bot's plugin fills only spots in its own tab, and its `locales` hold only its own keys;"

A5. Props bypass capabilities, and a send callback can speak as the user (§5.5): a message spot's entry gets the message without `conversation.read`, and a replacement composer's send has no rule.
- Old: "An entry gets only the declared props (data, plus callbacks the core routes back) and the tab's resolved tokens, which its own CSS may override."
- New: "… which its own CSS may override. **[P]** A declaration lists the capabilities its props carry data for (`needs`; the catalog sets `conversation.read` where messages show), and an entry whose plugin lacks one isn't mounted there. A callback that sends a message counts as the user's only right after the user's own key press or click in that frame, as the app sees it (§5.5); otherwise it is the plugin's (§5.4)." Add `needs?: string[]` to `PointDecl`.

A6. The declared-hosts mechanism can't work as written (§5.3). Electron sets sessions per webContents or `<webview>`, and I found no way to give an iframe its own, so a plugin's frame in another layer uses that layer's session; `webRequest` never sees WebRTC, and Figma enforces through CSP. The [D] stands; only the clause changes.
- Old: "each plugin origin's session refuses the rest, as Figma enforces declared domains."
- New: "the core serves each plugin origin's documents and workers with a Content-Security-Policy listing only those hosts, as Figma does, the layer's session refuses other requests that origin starts (`initiatorOrigin`), and WebRTC, which `webRequest` never sees, is off in plugin origins; S9 checks all three."

A7. Does a plugin see a secret's value? §5.2's [D] says "A plugin gets only its own secrets, through the plugin API", which has no such call; §5.1 says tokens reach code only through the fetch, yet SigV4 adapters and `stdio` `env` need values.
- Old: "that is what the capability gates."
- New: "that is what the capability gates, for keys and tokens alike. Only a process of the plugin's own sees a value: a `stdio` server through `env`, or an adapter that must sign with it (§5.2) through `secrets.get` (§5.4)."

A8. Data folders: "closed" (§5.4, item 71's [D]) or only write-protected (§9.1)?
- Old: "It also denies reading the run folder, as Winter's does"
- New: "It also denies reading plugins' data folders, which item 71 closes to bots' tools, and the run folder, as Winter's does" (§9.3's hidden paths and S8 gain them too).

A9. §12 says "Claude Code plugin folders are wrapped from 1.111.1", but no phase builds the wrapper.
- Old: "the wrappers for MCP configs, skills and agent files,"
- New: "the wrappers for MCP configs, skills, agent files and Claude Code plugin folders,"

A10. A development folder can give a bot two writers (§5.6 against §6.5): a dev copy of an installed bot "thinks and shows there" while the main runs the installed one, with the same memory.
- Old: "One with an installed plugin's id replaces that plugin there while it is on."
- New: "… while it is on; if that plugin holds a bot, it takes effect only on the computer running that bot and waits elsewhere, so the bot keeps one writer (§6.5)."

A11. "Refused" means both the user's no and the app's rejection, so by "A refused plugin stays off until its folder changes", a plugin refused for `engines` stays off after the app updates.
- Old: "is refused, with the version it needs."
- New: "is invalid, with the version it needs, and is checked again when the app updates."
- Old: "is refused alone," New: "is invalid alone,"

A12. Two readings each (§5.3): is `message.in` only the user's text, and does `message.out` stop streaming?
- Old: "`message.in` may replace the user's text before the model sees it, and `message.out` the bot's text before it is stored and shown;"
- New: "`message.in` may replace a message's text before the model sees it, the user's or one that folds in, and `message.out` the bot's text before it is stored and shown, so while a `message.out` hook is on, replies show and are spoken only after it runs;"

A13. Where `host.call` runs (§5.4): §5.2 starts the host half wherever a contribution runs, UI included, so "otherwise on the main" never happens unless UI doesn't count.
- Old: "A call runs on the component's computer if the host half runs there, and otherwise on the main, which starts it if needed."
- New: "A call runs on the component's own computer, where the host half starts with the component (§5.2), unless `platforms` leaves that computer out; then it runs on the main, which starts it if needed."

A14. Core rules that still name plugin points or kinds (check 3).
- Old: "The `approval` cell can't be hidden," New: "A key that its point's declaration lists in `keep` can't be hidden (the catalog lists `approval`, as item 70 says)," plus `keep?: string[]` in `PointDecl`.
- Old: "Every ancestor of an approval cell stays free of filters" New: "Every ancestor of a sealed frame stays free of filters"
- Old: "Computer-use plugins learn where Wyrmhole's windows are through the plugin API (`computers.control`, §5.4)" New: "A plugin with `computers.control` learns where Wyrmhole's windows are (§5.4)"
- Old: "Computer-use plugins take and release them through the plugin API," New: "Plugins with `computers.control` take and release them through the plugin API,"
- Old: "the list of remote calls, the computer registry, the credential store, or the app's main process, theme engine and sealed frames." New: "the list of remote calls, the protocol's command method, the computer registry, the credential store, or the app's main process, audio, theme engine and sealed frames." As written, `commands` and `voices` fail the rule's own test.
- MCP Apps' "the conversation view" reaches only `wyrm`'s view (B8 fixes it); §12's `status` mapping names a catalog spot only in migrated manifests, like a template.

A15. Style entries (§5.5): the rules below pick only a winner, nothing puts a style entry after the filler's own CSS, and `@scope` limits matching, not painting, so `position: fixed` escapes any part but a tab.
- Old: "several stack in the order the rules below give, the winner last."
- New: "several apply in the reverse of the order the rules below give, so the one that would win applies last; the core inserts each after the filler's own CSS and gives the part it dresses `contain: layout paint`, as a tab's root has."

**B. Gaps that would block a phase**

B1 (W1). The keyed fetch has no name, key choice or exemption from the 10-second limit, though every adapter streams through it; settings, host-to-component messages and the caller are used but undefined. Add after "Neither sits in the plugin folder, so neither changes its hash.":
> * **[P] The keyed fetch:** `net.fetch(url, init, { auth })` goes through the core, which adds the named `auth` entry's key or token (the only one by default), reaches only the plugin's `network:` hosts, refuses a redirect elsewhere, streams both ways with no limit while data flows, and after a 401 gets a newer token from the refresher and retries once (§3.3). A process of the plugin's own that must sign (§5.2) reads its secret with `secrets.get(name)`; a worker can't.
> * **[P] Settings:** `settings.get` and `settings.watch` read the plugin's own values; `settings.set` changes them, as a sealed card outside the `wyrm` layer (§5.5).
> * **[P] Its components:** `ui.send(event, data)` reaches their `host.on`.
> * **[P] The caller:** every command, tool and point handler is told who called: the user and the client, a bot's or agent's session, or a plugin by id. The core method is `command.run`, with `command.list` for the palette; a bot's session runs commands as the bot.

B2 (W1). The OK, sync, the hash check on host halves, index entries and revocations all rest on an undefined tree hash, and §5.9 has no index or revocation format. Add after "It updates like an index plugin.":
> **[P]** The tree hash is SHA-256 over a sorted list with one line per file: its path in the plugin folder (with `/`), its executable bit and the SHA-256 of its bytes. It leaves out only `.DS_Store`, `Thumbs.db` and `.git/`, and a symlink out of the folder makes it invalid. A version downloads as a `.tar.gz` whose tree hash must match, and an index or revocation list is signed with Ed25519 over its exact bytes, in a `.sig` file beside it.

In §5.9: `// Index format 1: { index: 1, name, plugins: [{ id, versions: [{ version, hash, url }] }] }; revocations: { revocations: 1, entries: [{ id, versions?, hashes?, reason }] }`.

B3 (W1). Nothing says what the catalogs' handler contracts hold, yet W1 ships `host` MCP servers, hooks and commands. Add after "A hook that throws or runs past its `timeoutMs` (default 10 seconds) is skipped, and Settings shows it.":
> **[P] Handlers.** A `host` server is an MCP server built with the official MCP SDK on an in-process transport the plugin SDK provides. A hook handler gets `{ event, session, bot, computer, tool?, input?, result?, text? }` and returns only what its event allows. A hook's `command` speaks Claude Code's hook protocol (JSON on stdin and stdout, exit code 2 to deny) under Claude Code's event names where one exists (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`), and the core ignores an `allow`. `tools` lists exact names, or patterns with `*`.

B4 (W1). The Claude Code wrapper breaks most real plugins: the manifest is optional, names needn't fit our ids, plugins read `CLAUDE_PLUGIN_ROOT` from their environment and use `${user_config.KEY}`, and commands are single files. Add after "Parts with no Wyrmhole point yet (output styles, LSP servers, mods) stay in the folder unused, and the OK names them.":
> **[P]** A folder is a Claude Code plugin if it has `.claude-plugin/plugin.json`, or no `wyrmhole.json` but any of Claude Code's default parts (`skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`). Its name gets a server name's clean-up, and each command file becomes a generated skill folder. `${user_config.KEY}` becomes `${setting:KEY}`, or `${secret:KEY}` when `sensitive`; `directory` and `file` options become strings. Its hook and `stdio` processes also get `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and `CLAUDE_PLUGIN_OPTION_<KEY>`, and both paths are filled in within its skill and agent text, as Claude Code does. A hook keeps its own timeout (600 seconds when unset). Unmatched hook events and types, `multiple` options, `bin/`, monitors, workflows, themes and `dependencies` stay unused, and the OK names them.

B5 (W1, W4). `chosen` has no home or default. Add after "An entry with no `runsOn` runs where the table says.":
> **[P]** The computers ticked for `chosen` are an account setting, synced with the installed-plugins list (§8.5); a new plugin starts ticked on the computer it was added on.

B6 (W2). Keyed spots have no default entry, so `bot.tab` can't show the default tab for every bot. Add after "A spot shows one entry (`single`), every entry in order (`list`), or one entry per key (`keyed`).":
> **[P]** In a keyed spot, an entry with no `key` fills every key that has no entry of its own, as the default bot tab fills `bot.tab`; a `key` ending in `*` (`image/*`) fills the keys it matches, after exact ones.

B7 (W2). Sealed frames have no placement API, and "cards keep the styling last OK'd" means nothing for code. Add after "A development folder (§5.6) is exempt.":
> **[P]** A component with `approvals` hears pending cards' ids and computers, never their text (`approvals.watch`), and places one with the plugin SDK's `<Card id>` and its parts (`<Card.Field name>`, `<Card.Approve>`, `<Card.Deny>`). While a change to a component's card styling waits for its OK, the core keeps its last OK'd version and mounts that wherever it places frames.

B8 (W2). The MCP Apps bridge: the extension also has `ui/message` (with a role, `user` in its example), `ui/update-model-context`, `ui/open-link`, `visibility` and `permissions`, and one reading posts as the user. Add after "Since the page runs isolated, it doesn't change its plugin's class.":
> **[P]** The bridge gives the page `tools/call` only for its own server's tools whose `_meta.ui.visibility` includes `app`, plus `resources/read` and `ui/request-display-mode`. `ui/message` and `ui/update-model-context` reach the bot as outside content labelled with the plugin, never as the user's, so a turn they start is the plugin's (§5.5); `ui/open-link` opens the user's browser; the page gets no camera, microphone, location or clipboard. A tool whose visibility leaves out `model` never reaches a bot, `Glossary` or an agent. A component that shows a tool's result places the page with the plugin SDK's `<AppView call>`; a page no component places within 2 seconds shows as text.

B9 (W2). The locale format has no placeholders, plurals or precedence, and no prefix for a child's keys. Add after "a manifest's `Text` can carry its translations inline (§5.9).":
> **[P]** Strings use `{name}` placeholders, and a key may hold plural forms (`{ one, other, … }`, by the language's rules). A child's keys start with its top-level plugin's id. For one key, a plugin's own table beats a pack's; between two packs the user picks in Settings, the first enabled applying until then. A missing string falls back from `pt-BR` to `pt`, then to English, then to any language its plugin has.

B10. Smaller guesses: §5.9's `oauth-pkce` lacks `clientId`, `scopes` and a loopback redirect (RFC 8252), which non-model sign-ins need; `network:<host>` has no syntax (ports, `*.` subdomains); `PointDecl.context` is described nowhere ("the keys a spot offers to `when`, such as `bot`"); `audio` should record only while push-to-talk is held unless the user turns listening on (§5.7), with an OK saying it "can hear your microphone"; and a core shortcut or the user's binding should beat a plugin's `key`.

**C. Questions for the owner**

C1. Who may translate sealed cards and the OK? Item 68 ([D]) lets any language pack, a data plugin with a light OK, translate "sealed cards and the welcome guide". That contradicts the [D] that a plugin "cannot rewrite or fake" card text, and it is unsafe: a pack can swap Approve and Deny or soften the OK for a found plugin, and a bot can edit an installed pack's file, which applies at once.
- (a) Recommended: card and OK strings come only from the built-in tables, packs in `wyrm` and packs whose tree hash matches the official index; other packs translate everything else, and cards fall back to English. Cost: community card translations wait for index review.
- (b) Any pack may translate them, but that counts as card styling: its OK says "translates approval cards and Wyrmhole's warnings", and a later change to those strings waits for its own OK (item 51). Cost: a pack the user OKs can still mislabel buttons, as card styling already can.
- (c) Cards and OKs only in the built-in languages. Cost: drops "sealed cards included" from item 68.

**D. External claims checked**

1. MCP 2026-07-28: `server/discover` returns an optional `instructions` (servers MUST implement it, clients MAY skip it, and modern revisions have no `initialize`), and tool names "SHOULD" use letters, digits, `_`, `-` and `.`, 1–128 characters. Correct; the core must call `server/discover` itself. https://modelcontextprotocol.io/specification/2026-07-28/server/discover , https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle , https://modelcontextprotocol.io/specification/2026-07-28/server/tools
2. MCP Apps: "Stable (2026-01-26)", `io.modelcontextprotocol/ui`, `_meta.ui.resourceUri` on the tool, `_meta.ui.csp` on the UI resource (`connectDomains`, `resourceDomains`, `frameDomains`, `baseUriDomains`), "Host MAY further restrict but MUST NOT allow undeclared domains". Correct; omitted are `ui/message`, `ui/update-model-context`, `ui/open-link`, `visibility` (hosts "MUST NOT include" app-only tools in the agent's list) and `permissions` (B8). https://modelcontextprotocol.io/extensions/apps/overview , https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
3. Claude Code: the named parts exist (`${CLAUDE_PLUGIN_DATA}` is `~/.claude/plugins/data/<id>/`), but "The manifest is optional", names need only avoid spaces, `@`, `:` and separators, both variables are also filled in within skill and agent text and exported to hook and stdio processes, `userConfig` adds `directory`, `file`, `multiple`, `${user_config.KEY}` and `CLAUDE_PLUGIN_OPTION_<KEY>`, hooks default to 600 seconds, and a `PreToolUse` `allow` "skips the permission prompt" ("Deny and ask rules are still evaluated regardless"). Wrapper incomplete (B4), placed hooks unsafe (A1). https://code.claude.com/docs/en/plugins-reference , https://code.claude.com/docs/en/hooks
4. Electron: `webRequest` belongs to a `Session`, its details carry `frame` and `initiatorOrigin`, its types include `webSocket` but not WebTransport, and WebRTC isn't a web request; sessions are set per webContents or `<webview>` (`partition`); Figma's enforcement is a CSP error. Works only as an origin filter plus CSP, with WebRTC off (A6). https://www.electronjs.org/docs/latest/api/web-request , https://www.electronjs.org/docs/latest/api/webview-tag , https://developers.figma.com/docs/plugins/making-network-requests/
5. CSS: `@scope`'s lower bound is exclusive but it limits matching only (A15); `@property` registrations are "not scoped to a tree scope" ("a single global registration map"), so dropping them is right; layout and paint containment each establish "an absolute positioning containing block and a fixed positioning containing block". Correct. https://developer.mozilla.org/en-US/docs/Web/CSS/@scope , https://drafts.css-houdini.org/css-properties-values-api-1/ , https://www.w3.org/TR/css-contain-2/
6. Winter: `ProviderContext.credentials: CredentialStore` (`winter-agent-sdk/packages/provider-runtime/src/types.ts:500`), `contributes.shortcuts` as `{ id, description?, default? }` and `<name>@<marketplace>` (`docs/claude/runtime-home.md:31`) are correct; a `tile` is `{title, value?, icon?, progress?, actions?}` (`packages/protocol/src/methods.ts`), more than "a title and a value" (F2).

**F. Wording**

1. Old: "The core keeps them away only from other plugins' UI, and on macOS from" → New: "The core keeps them away only from other plugins' UI and the sealed cards, keeps their UI code to the hosts they declare, and on macOS keeps host code from"
2. Old: "its `tile` (a title and a value the plugin pushes)" → New: "its `tile` (a title, value, icon, progress and action buttons the plugin pushes)"
3. Old: "hyphens at either end dropped, cut so the id fits 40 characters," → New: "cut so the id fits 40 characters, hyphens at either end then dropped (the same for `skill-`, `agent-` and `claude-` names),"
4. Old: "single hyphens, at most 40; default = id; children share it; "wyrm" reserved" → New: "single hyphens, a letter or digit at each end, at most 40; default = id; children share it; "wyrm" reserved"
5. Old: "Any other point is filled with a top-level key" → New: "Any other point a plugin declares is filled with a top-level key"
6. Old: "// Interpolation: ${plugin} (the folder path), ${data} (its data folder, §5.4), ${setting:k}, and ${secret:k}, which" → New: "// Interpolation (stdio command/args/env, http url/headers, hook and agent-backend command/args): ${plugin} (the folder path), …"
7. Old: "`confirm(text)` shows a sealed card with the plugin's name and its text" → New: "`confirm(text)` shows a sealed card that says it comes from a plugin, with the plugin's name, id and source and its text"
8. Old: "A call times out after 10 seconds unless it sets a longer limit, up to 10 minutes," → New: "A plugin-API call times out after 10 seconds unless the caller sets a longer limit, up to 10 minutes (tool calls, hooks, `confirm` and the keyed fetch keep their own limits),"
9. Old: "Callbacks and events go the other way, through points." → New: "… through points. **[P]** `call:<plugin-id>` names a top-level plugin and covers its children, whose commands share its namespace, and command names are unique within that namespace."
10. Old: "nothing loads them natively." → New: "Wyrmhole never loads them natively, and a Claude Code agent still loads what its own install has, as item 59 runs each agent." (the reading that agrees with item 59)
11. Old: "ticked as its manifest's `when.bot` says, or all if it says nothing;" → New: "ticked as its entries' `when.bot` say together, or all if none says;"
12. Old: "so this rule names no point." → New: "so this rule names no point a plugin declares."
13. Old: "`computers.control` (§9.2); and, with the owner's answers," → New: "`computers.control` (§9.2), keys out of adapters on every OS (§5.2), the app recording audio (§6.6), data folders in the fence (§9.1), hooks placed in Claude Code (§9.3) and the `shortcuts` and `tile` mapping (§12); and, with the owner's answers,"

A read-only script confirmed that every Old quote and anchor sentence above occurs exactly once in `~/Xcode progects/Norma v2/docs/wyrmhole-spec.md`. No repo file was changed; I deleted only my scratch folder `review-r14-verify/`.
