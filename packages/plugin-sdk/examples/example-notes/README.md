# Notes, a full example plugin

A small, real plugin that uses every kind of contribution a plugin that stays on your computers can: notes you jot
down in chat or with `/note`, a Notes page, and tools any of your bots or coding agents can keep and tidy them with. Its twin, `../example-weather`, shows
what changes once a plugin reaches the network.

| Part | Where | What it shows |
|---|---|---|
| Host code (`host.entry`, Bun) | `server/index.ts`, `server/notes.ts` | the `notes` MCP server, the hook, the command and the page's door |
| MCP tools | `server/index.ts` | `add_note` is `contained` and `list_notes` is `readOnly`: both run without a card at the default level, because the plugin reaches no network and holds no capability. `delete_note` is on neither list, so it asks every time. |
| A hook, `tool.after` | `onToolAfter` | counts the calls of its own tools (`tools: ["mcp__example-notes-notes__*"]`), in a bot's session and a code session alike; it only observes |
| A command | `note` | `/note <text>` from the composer's slash menu, run as you |
| A skill | `skills/tidy-up/SKILL.md` | found and loaded through Glossary |
| An agent definition | `agents/tidier.md` | words for the agent a big tidy is handed to (`example-notes:tidier`) |
| A setting | `order` in `moss.json` | the page's order. The page's own switch changes it with no card (a plugin's page writes its own plain settings), and so does its control on the Plugins page; the page hears either change. A setting that feeds a host, a server's arguments or environment, or a command hook would ask on a card instead. |
| Synced storage | `notes`, `uses` | the notes follow you to every computer running the plugin |
| A page and a sidebar entry | `client/index.tsx` | TSX with React and the UI SDK from the layer (the folder ships neither; MOSS builds it after your OK); it reads through `host.call("list")` and hears its store and its setting change |
| Translations | `locales/en.json`, `locales/ja.json` | the page's strings |

Check it with `moss plugin validate`, try it with `moss plugin dev .`, and install it from the Plugins page (Add,
Choose a folder…).
