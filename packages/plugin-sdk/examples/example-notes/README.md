# Notes, a full example plugin

A small, real plugin that uses every kind of contribution a plugin that stays on your computers can: notes you jot
down in chat or with `/note`, a Notes page, and a bot that keeps and tidies them. Its twin, `../example-weather`, shows
what changes once a plugin reaches the network.

| Part | Where | What it shows |
|---|---|---|
| Host code (`host.entry`, Bun) | `server/index.ts`, `server/notes.ts` | the `notes` MCP server, the hook, the command and the page's door |
| MCP tools | `server/index.ts` | `add_note` is `contained` and `list_notes` is `readOnly`: both run without a card at the default level, because the plugin reaches no network and holds no capability. `delete_note` is on neither list, so it asks every time. |
| A bot, in a child plugin | `plugins/bot/` | Notes keeper. A plugin that brings a bot adds UI only inside its own tab, so the bot lives in a child and the page stays in the parent. Its `model.default` names the model it runs on; with no key for that model's provider, it runs on your default model. |
| Its theme and window skin | `plugins/bot/theme/theme.json` | colours for its tab, and a `shell` block that dresses the title bar and the sidebar while its tab shows |
| A hook, `own-bot` | `onTurnEnd` | counts Notes keeper's turns; it sees no other bot |
| A command | `note` | `/note <text>` from the composer's slash menu, run as you |
| A skill | `skills/tidy-up/SKILL.md` | found and loaded through Glossary |
| An agent definition | `agents/tidier.md` | words for the agent your bot hands a big tidy to (`example-notes:tidier`) |
| A setting | `order` in `clover.json` | the page's order. The page's own switch changes it with no card (a plugin's page writes its own plain settings), and so does its control on the Plugins page; the page hears either change. A setting that feeds a host, a server's arguments or environment, or a command hook would ask on a card instead. |
| Synced storage | `notes`, `turns` | the notes follow you to every computer running the plugin |
| A page and a sidebar entry | `client/index.tsx` | TSX with React and the UI SDK from the layer (the folder ships neither); it reads through `host.call("list")` and hears its store and its setting change |
| Translations | `locales/en.json`, `locales/ja.json` | the page's strings |

Check it with `clover plugin validate`, try it with `clover plugin dev .`, and install it from the Plugins page (Add,
Choose a folder…).

Clover doesn't yet build a TypeScript client when a plugin loads. Until it does, build the page into a module and point
`client.entry` at it (React and the UI SDK stay outside it: the layer's import map serves them):

```sh
bun build client/index.tsx --outfile client/index.js --format esm --target browser \
  --external react --external react-dom --external "react/*" --external "react-dom/*" \
  --external @waifucave/clover-plugin-sdk/ui
```

Then set `"client": { "entry": "client/index.js" }` in `clover.json`.
