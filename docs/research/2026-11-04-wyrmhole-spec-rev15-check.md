# Wyrmhole spec: the last check, of revision 15

Reviewer: a fresh read-only Opus reviewer, November 4, 2026, running the narrow check of revision 15's changes under the owner's stopping rule: if it found nothing that blocks a phase or breaks a safety guarantee, the plugin section freezes.

Status: received November 4, 2026. Its verdict was "freeze" (0 blocking, 0 safety, 3 minor), so by the owner's rule the plugin section froze at spec revision 16 (item 73). Revision 16 applies its three minor fixes and the revision-14 check's A4, which revision 15 had missed by mistake and which this check found absent (its C1); the recommended option was that fix, which keeps both decisions involved, so it was applied rather than asked. Changed while applying: A2 counts a send as the user's when it uses up the frame's transient user activation from a hardware key press or click, one send per gesture, instead of matching "the text the user composed" and "the send control", which the app can't see inside a plugin's frame; A3 resolves the two readings the other way, so a plugin changes its own settings directly from any of its parts, and §5.5's sealed-card rule now names the core's settings; D2's note made the Claude Code environment variables exact (hooks get all three, `stdio` servers the two paths).

---

**Verdict: freeze.** 0 blocking, 0 safety, 3 minor. Plus 1 question for the owner (a [D]/[D] contradiction, Section C).

Revision 15 is almost entirely a tightening pass that fills the gaps the rev14 check named (tree hash and signatures, the keyed fetch, `secrets.get`, the caller, handler contracts, the Claude Code wrapper, the MCP Apps bridge, `needs`/`keep`, keyed defaults, card placement, string formats). I checked every changed region against the rest of the spec, the §5.9 manifest, and primary sources. The three hard boundaries this spec actually defends — the sealed-card/approval path, own-only secrets, and declared hosts for components — are each strengthened, not weakened. Against the six safety tests: no new rule lets a bot, agent or plugin raise its access, forge or read a sealed card, run code with no OK, reach another's secret, or (materially) get past the declared hosts; "act as the user" is bounded by the spec's own model (§5.6: a host plugin "can do anything the user can," so the real boundary is the forge-proof sealed card, which holds). No W1/W2 dependency is left to guess at.

---

### A. Fixes (all minor)

**A1 (minor) — the declared-host mechanism misses DNS-level and navigation leaks; the clause over-credits CSP.** Primary sources: CSP's `navigate-to` was removed from CSP Level 3 (Sept 2022) and never shipped, so CSP cannot restrict navigation targets at all — only the `initiatorOrigin` filter catches navigations (they carry `initiatorOrigin` as `mainFrame`/`subFrame`). And DNS prefetch / speculative hints are DNS-level, so neither `webRequest` nor CSP reliably stops them (Chromium's fix is still flag-gated). This is defense-in-depth for *components* (host code may reach any host anyway), hence minor, but the enumerated mechanism should name it.
- Old (§5.3): `and WebRTC, which `webRequest` never sees, is off in plugin origins; S9 checks all three.`
- New: `and WebRTC, which `webRequest` never sees, is off in plugin origins, and DNS prefetching and speculative resource hints (preconnect, prefetch, prerender), which can reach a host before `webRequest` or the CSP sees it, are off there too; S9 checks them all.`
- Companion edit (§14.1, S9, occurs once): change `CSP, `initiatorOrigin` and WebRTC off` to `CSP, `initiatorOrigin`, WebRTC off and DNS prefetch/resource hints off`.

**A2 (minor) — the user-attested send ties attribution to a bare event, not to the composed text or the send control.** As written, a replacement composer could attribute plugin-chosen content to the user right after any incidental real click/keypress in its frame. The hard boundary still holds (a forged user message cannot answer a sealed card — those are core-owned frames with the hardware-click check), so this is an honest-attribution refinement, matching the sealed-button discipline the clause already invokes.
- Old (§5.5): `A callback that sends a message counts as the user's only right after the user's own key press or click in that frame, which the app checks as it does for sealed buttons (below); otherwise the message is the plugin's (§5.4).`
- New: `A callback that sends a message counts as the user's only when it carries the text the user composed and fires right after the user's own key press or click on that frame's own send control, which the app checks as it does for sealed buttons (below); a send with other content, or with no such event, is the plugin's (§5.4).`

**A3 (minor, one-reading) — `settings.set` reads two ways against §5.5.** The new §5.4 line says `settings.set` "changes them" directly, while §5.5 says "another layer's change becomes a sealed card." A non-`wyrm` UI component calling `settings.set` for its own values has two readings (direct, or card). The deliberate departure the rev14 check recorded (direct, because only that plugin's code can call it) is right for the *host half*; the sentence should say which surface it means.
- Old (§5.4): `and `settings.set` changes them; a plugin changes only its own.`
- New: `and `settings.set` changes them from the plugin's host half; a plugin changes only its own, and §5.5 still governs a settings change requested from a UI layer.`

---

### B. Gaps that would block a phase

**None.** Every W1/W2 dependency the rev14 check flagged (B1–B10) is now written in and internally consistent: the tree hash and Ed25519 `.sig` format (§5.1) with the index and revocation formats in §5.9; `net.fetch`/`secrets.get`/settings/`ui.send`/the caller (§5.4); handler contracts and the Claude Code hook protocol (§5.3); the Claude Code folder detection and `${user_config.*}` mapping (§5.1); `chosen` as a synced account setting (§5.2, cross-checked to §8.5/§9.1); keyed defaults and `*` keys, `needs`/`keep`/`context` in `PointDecl`, the MCP Apps bridge, and the locale format (§5.5/§5.9); `oauth-pkce` `clientId`/`scopes`/loopback (§5.9). The MCP Apps `ui/initialize` handshake and `ui/notifications/size-changed` are not named, but they belong to the cited extension (`io.modelcontextprotocol/ui`) and are an implementation detail, not a spec unknown.

---

### C. Question for the owner

**C1 — a bot's plugin can translate the whole app, against the [D] that its UI stays in its tab ([D] vs [D]).** Item 72 closed the dangerous leg (sealed-card and OK text are now trusted-packs-only), but the rev14 check's broader A4 fix was **not** applied (confirmed absent), so a residual [D]/[D] contradiction stands for non-card text. A bot can edit its own plugin to add a `locales` entry with `wyrm.`-prefixed keys; locale data "applies at once," app-wide.
- Quote 1 (§5.5): `Keys start with their plugin's id and a dot, and the core's and `wyrm`'s with `wyrm.`, so one language pack, a data plugin, can translate the core and many plugins.`
- Quote 2 (§5.5, [D]): `Everything a bot's plugin adds to the UI applies inside that bot's tab, and it can fill only the spots inside the tab.`
- Reading A: locales are app-wide data (quote 1), so a bot's plugin's strings reach the whole app. Reading B: a bot's plugin's UI is tab-confined (quote 2), so its locales must be too.

Options (recommended first):
- **(a) Apply A4** — a bot's plugin's locale keys are its own only; cross-namespace / `wyrm.` translation comes only from a dedicated language pack (a non-bot data plugin). Add `and its locales hold only its own keys` after `a bot's plugin fills only spots in its own tab` (occurs once). Cost: a bot that ships UI translations ships them as a child language-pack plugin. Resolves the contradiction with the least surface.
- **(b) Declare it intended** — state in quote 2 that `locales` are the app-wide exception. Cost: a bot can silently retranslate non-card core/app text app-wide (card and OK text stay protected by item 72); the tab-confinement [D] gains a stated hole.
- **(c) Scope per tab** — a bot's plugin's locale strings apply only in its own tab. Cost: more plumbing (per-tab locale resolution) and a bot can't fix a core typo app-wide.

---

### D. Outside facts checked

1. **Claude Code hooks** — `PreToolUse` `allow` "skips the permission prompt," but "Deny and ask rules are still evaluated regardless"; the deprecated top-level `approve`/`block` map to `allow`/`deny`; exit code 2 denies; the events `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact` all exist; `command` hook default timeout is 600s. Confirms the §9.3 shim ("passes its deny and ask and drops an allow") is sound and the §5.3 handler contract is accurate. https://code.claude.com/docs/en/hooks
2. **Claude Code plugins** — the manifest `.claude-plugin/plugin.json` is optional; default locations are `skills/ commands/ agents/ hooks/hooks.json .mcp.json` (also `.lsp.json`, `output-styles/`, `workflows/`, `themes/`, `monitors/`, `bin/`, `settings.json`); `userConfig` types are `string/number/boolean/directory/file`, `sensitive` → secure store, `multiple` → array; `${user_config.KEY}` is substituted in MCP/LSP config, exec-form hook `args`, and skill/agent content (sensitive → placeholder in content); `CLAUDE_PLUGIN_DATA` = `~/.claude/plugins/data/<id>/`. Confirms §5.1. **Fidelity note:** Claude Code exports `CLAUDE_PLUGIN_OPTION_<KEY>` only to *hook* processes, not to stdio MCP servers; the spec's "Its hook and `stdio` processes also get … `CLAUDE_PLUGIN_OPTION_<KEY>`" is a Wyrmhole wrapper choice, not Claude Code behaviour — fine, but worth a word so "as Claude Code does" isn't read onto it. https://code.claude.com/docs/en/plugins-reference
3. **MCP Apps (`io.modelcontextprotocol/ui`, 2026-01-26)** — the Host MUST reject `tools/call` from an app for a tool whose visibility lacks `app`, and MUST NOT list tools lacking `model` to the agent; `ui/message` carries `role` (`user` in the example) and the Host SHOULD add it preserving role and MAY require consent; `ui/open-link` SHOULD open the browser; `permissions` (camera/microphone/geolocation/clipboardWrite) are optional iframe `allow`s. The spec safely hardens all of this (labels `ui/message` as the plugin's, never the user's; denies all device permissions). Confirms §5.5. https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
4. **Electron `webRequest`** — `details.initiatorOrigin` exists, persists across redirects, and is absent/`null` for browser-started/opaque requests; `resourceType` includes `mainFrame`, `subFrame`, `webSocket` but not WebTransport; WebRTC is not a web request. Confirms A6: `initiatorOrigin` (not CSP) is what covers navigations, and WebRTC must be separately disabled. https://www.electronjs.org/docs/latest/api/web-request
5. **CSP navigation / DNS prefetch** — `navigate-to` was removed from CSP3 (Sept 2022) and never shipped; CSP cannot restrict navigation targets (only `form-action` is navigation-adjacent). DNS prefetch historically bypasses CSP exfiltration controls; Chromium's `ResourceHintsLeastRestrictiveCSP` remains flag-gated/uncertain. Basis for A1. https://github.com/w3c/webappsec-csp/pull/564 , https://content-security-policy.com/navigate-to/ , https://blog.compass-security.com/2016/10/bypassing-content-security-policy-with-dns-prefetching/

---

**Verification:** a read-only Python script confirmed that each Old quote and anchor sentence in this report (A1, A2, A3, the C1 quotes and the A4 insertion anchor, the S9 companion line) occurs exactly once in the current spec, and that the rev14 check's A4 text is absent. I changed no file. My only scratch is `<the session's scratchpad>/review-r15-check/`; per instructions I leave deletion of that folder to you if you prefer, and I touched nothing else in the scratchpad (the backups are untouched).
