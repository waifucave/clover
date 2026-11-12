---
name: plugin-examples
description: Minimal working Clover plugins to copy - a tool, a settings section, a status-bar entry, a whole app (sidebar button plus its own page), an app whose tools let a bot drive its open page, a theme, a bot, a bot with its own tab and a child plugin, a model provider, a trigger, a data point other plugins fill, and a UI spot of your own that another plugin fills. Each one is checked by Clover's validator and loaded through the registry in its tests.
---

# Minimal working plugins

Each example is one plugin folder: the folder's name is the plugin's id, and every file is shown in full. Start from
the closest one: for those marked "From the template", the scaffold tool gives exactly these files (building-plugins
names it), so you only change them. Then follow plugin-loop.

What holds for all of them:

- `manifest: 1`, an `id` equal to the folder's name, a `name`, and `engines.clover` (required once there is code).
- Host code (`host.entry`) runs in Clover's plugin host under Bun; client code (`client.entry`) runs in the app's
  layer for the plugin. Neither ships dependencies: import only `@waifucave/clover-plugin-sdk` (types, in the host)
  and `@waifucave/clover-plugin-sdk/ui` (in the client: React's `createElement as h`, the hooks, `Spot`).
- A component is a function the client exports, named by a `ui` entry's `component`. Write it with `h(...)`; a `.tsx`
  client works too (`client/index.tsx`), and JSX then needs no import.
- A spot only shows where its part is: a section in Settings, a page under `main`, a widget where its declaring
  component draws it. Until that part is up the plugin waits for it; that is normal.

### Example: A tool (an MCP server in the host half) (`ex-tool`)

From the template `tool` (the scaffold tool with this id and the name "Ex tool" gives exactly these files).

File `clover.json`:
```json
{
  "manifest": 1,
  "id": "ex-tool",
  "name": "Ex tool",
  "description": "Ex tool, a tool.",
  "engines": {
    "clover": "^1.0.0"
  },
  "host": {
    "entry": "host/index.ts",
    "runtime": "bun"
  },
  "contributes": {
    "mcpServers": {
      "tools": {
        "type": "host",
        "tools": {
          "hello": "preload"
        }
      }
    }
  }
}
```

File `host/index.ts`:
```ts
// Ex tool's host half: one MCP server, `tools`, served on the in-process transport Clover hands it. It speaks
// MCP's JSON-RPC directly, so the plugin ships no dependency. Its key here is the one under `contributes.mcpServers`.
import type { HostModule, McpServerTransport } from "@waifucave/clover-plugin-sdk";

const TOOLS = [
  {
    name: "hello",
    description: "Says hello to someone by name.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Who to greet" } }, required: ["name"] },
  },
];

function answer(method: string, params: Record<string, unknown> | undefined): unknown {
  if (method === "initialize") return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ex-tool", version: "0.1.0" } };
  if (method === "tools/list") return { tools: TOOLS };
  if (method === "tools/call" && params?.name === "hello") {
    const who = String((params.arguments as { name?: unknown } | undefined)?.name ?? "there").slice(0, 100);
    return { content: [{ type: "text", text: `Hello, ${who}!` }] };
  }
  throw new Error(`unknown method ${method}`);
}

export const mcp: HostModule["mcp"] = {
  tools: async (transport: McpServerTransport) => {
    transport.onmessage = (m) => {
      if (typeof m.id !== "number" && typeof m.id !== "string") return; // a notification: nothing to answer
      try {
        void transport.send({ jsonrpc: "2.0", id: m.id, result: answer(String(m.method), m.params as Record<string, unknown> | undefined) });
      } catch (err) {
        void transport.send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: err instanceof Error ? err.message : String(err) } });
      }
    };
    await transport.start();
  },
};
```

File `README.md`:
```markdown
# Ex tool

A tool. Its MCP server, `tools`, is in `host/index.ts`, with one tool, `hello`; list each tool you add under `contributes.mcpServers.tools` in `clover.json`. It asks for no network and no files: add `network` or a capability to the manifest only when a tool needs one, and the OK card will say so.

Check it with `clover plugin validate`, and try it on this computer with `clover plugin dev .`.
```

### Example: A settings section (a component in a spot) (`ex-settings`)

From the template `ui` (the scaffold tool with this id and the name "Ex settings" gives exactly these files).

File `clover.json`:
```json
{
  "manifest": 1,
  "id": "ex-settings",
  "name": "Ex settings",
  "description": "Ex settings, a part of the app.",
  "engines": {
    "clover": "^1.0.0"
  },
  "client": {
    "entry": "client/index.ts"
  },
  "contributes": {
    "ui": [
      {
        "spot": "settings.section",
        "id": "section",
        "component": "ExSettingsSection",
        "title": "Ex settings"
      }
    ]
  }
}
```

File `client/index.ts`:
```ts
// Ex settings's client half: the components its manifest's `ui` entries name. React comes from the layer, through
// the plugin SDK, so the plugin ships none of its own.
import { createElement as h, useT } from "@waifucave/clover-plugin-sdk/ui";

export function ExSettingsSection() {
  const t = useT();
  return h("p", null, t("Hello from Ex settings."));
}
```

File `README.md`:
```markdown
# Ex settings

A UI part: a section of Settings, drawn by the component in `client/index.ts`. Its `ui` entry in `clover.json` says which spot it fills; the catalog lists the spots.

Check it with `clover plugin validate`, and try it on this computer with `clover plugin dev .`.
```

### Example: A theme (`ex-theme`)

From the template `theme` (the scaffold tool with this id and the name "Ex theme" gives exactly these files).

File `clover.json`:
```json
{
  "manifest": 1,
  "id": "ex-theme",
  "name": "Ex theme",
  "description": "Ex theme, a theme.",
  "engines": {
    "clover": "^1.0.0"
  },
  "contributes": {
    "themes": [
      {
        "id": "ex-theme",
        "file": "theme.json"
      }
    ]
  }
}
```

File `theme.json`:
```json
{
  "theme": 1,
  "name": "Ex theme",
  "appearance": "both",
  "tokens": {
    "color.canvas": "#F4F6F2",
    "color.surface": "#FFFFFF",
    "color.text": "#1E2420"
  },
  "dark": {
    "tokens": {
      "color.canvas": "#151916",
      "color.surface": "#1C211D",
      "color.text": "#E8ECE7"
    }
  }
}
```

File `README.md`:
```markdown
# Ex theme

A theme. Its tokens are in `theme.json`: any of the catalog's tokens, each with a light value and, under `dark`, a dark one where it differs.

Check it with `clover plugin validate`, and try it on this computer with `clover plugin dev .`.
```

### Example: A bot (`ex-bot`)

From the template `bot` (the scaffold tool with this id and the name "Ex bot" gives exactly these files).

File `clover.json`:
```json
{
  "manifest": 1,
  "id": "ex-bot",
  "name": "Ex bot",
  "description": "Ex bot, a bot.",
  "engines": {
    "clover": "^1.0.0"
  },
  "contributes": {
    "bot": {
      "name": "Ex bot",
      "instructions": "bot/instructions.md"
    }
  }
}
```

File `bot/instructions.md`:
```markdown
You are Ex bot. Say who you are and how you help, in a few short paragraphs.
```

File `README.md`:
```markdown
# Ex bot

A bot. Its instructions are in `bot/instructions.md`; its manifest, `clover.json`, can also give it a model, a voice, an avatar and a theme.

Check it with `clover plugin validate`, and try it on this computer with `clover plugin dev .`.
```

### Example: A model provider (a compatible endpoint, no code) (`ex-model`)

From the template `model` (the scaffold tool with this id and the name "Ex model" gives exactly these files).

File `clover.json`:
```json
{
  "manifest": 1,
  "id": "ex-model",
  "name": "Ex model",
  "description": "Ex model's models, on its compatible endpoint.",
  "engines": {
    "clover": "^1.0.0"
  },
  "contributes": {
    "models": [
      {
        "provider": "ex-model",
        "name": "Ex model",
        "catalog": "catalog.json",
        "auth": [
          {
            "method": "api-key",
            "secret": "api-key",
            "help": "Your Ex model API key. Clover keeps it in your credential store."
          }
        ],
        "endpoint": {
          "protocol": "openai-chat",
          "baseUrl": "https://api.example.com/v1"
        }
      }
    ]
  }
}
```

File `catalog.json`:
```json
{
  "catalog": 1,
  "provider": {
    "protocols": [
      "openai-chat-completions"
    ],
    "authKinds": [
      "api-key"
    ]
  },
  "models": [
    {
      "id": "example-model",
      "name": "Example model"
    }
  ]
}
```

File `README.md`:
```markdown
# Ex model

A model provider. Put the provider's endpoint in `clover.json` (`endpoint.baseUrl`, and the protocol it speaks), and its models in `catalog.json`. Clover asks for the API key when someone signs in. The endpoint's host is the plugin's network: the example's `api.example.com` shows as a network host on the OK card, so put the provider's own there.

Check it with `clover plugin validate`, and try it on this computer with `clover plugin dev .`.
```

### Example: A trigger for routine files (`ex-trigger`)

From the template `trigger` (the scaffold tool with this id and the name "Ex trigger" gives exactly these files).

File `clover.json`:
```json
{
  "manifest": 1,
  "id": "ex-trigger",
  "name": "Ex trigger",
  "description": "Ex trigger: a trigger for routine files.",
  "engines": {
    "clover": "^1.0.0"
  },
  "host": {
    "entry": "host/index.ts",
    "runtime": "bun"
  },
  "contributes": {
    "triggers": [
      {
        "type": "ex-trigger",
        "title": "Ex trigger",
        "fields": {
          "type": "object",
          "required": [
            "every"
          ],
          "properties": {
            "every": {
              "type": "integer",
              "minimum": 1,
              "maximum": 10080,
              "description": "Minutes between runs."
            }
          }
        },
        "handler": "exTrigger"
      }
    ]
  }
}
```

File `host/index.ts`:
```ts
// Ex trigger's host half: the handler its `triggers` entry names. The routine engine asks it whether a routine's
// fields read (`check`), when it fires next (`next`), and which fires a computer that was off missed (`missed`).

function minutes(fields: unknown): number {
  const every = (fields as { every?: unknown } | null | undefined)?.every;
  if (typeof every !== "number" || !Number.isInteger(every) || every < 1 || every > 10080) throw new TypeError("`every` is a whole number of minutes, from 1 to 10080");
  return every;
}

export const exTrigger = {
  check(args: { fields: unknown }): { ok: true; summary: string } | { ok: false; reason: string } {
    try {
      return { ok: true, summary: `every ${minutes(args.fields)} minutes` };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },
  next(args: { fields: unknown; after: number }): { at: number } {
    return { at: args.after + minutes(args.fields) * 60_000 };
  },
  // An interval has no fixed times: the engine runs a missed one once when the computer wakes.
  missed(_args: { fields: unknown; after: number; until: number }): { at: number[] } {
    return { at: [] };
  },
};
```

File `README.md`:
```markdown
# Ex trigger

A trigger. A routine file uses it as `- ex-trigger: { every: 30 }`; its handler is in `host/index.ts`.

Check it with `clover plugin validate`, and try it on this computer with `clover plugin dev .`.
```

### Example: A point other plugins fill (data) (`ex-point`)

From the template `point` (the scaffold tool with this id and the name "Ex point" gives exactly these files).

File `clover.json`:
```json
{
  "manifest": 1,
  "id": "ex-point",
  "name": "Ex point",
  "description": "Ex point: a point other plugins fill.",
  "engines": {
    "clover": "^1.0.0"
  },
  "client": {
    "entry": "client/index.ts"
  },
  "contributes": {
    "ui": [
      {
        "spot": "settings.section",
        "id": "section",
        "component": "ExPointSection",
        "title": "Ex point",
        "declares": {
          "ex-point.items": {
            "shape": "list",
            "fields": {
              "type": "object",
              "required": [
                "id",
                "title"
              ],
              "properties": {
                "id": {
                  "type": "string"
                },
                "title": {
                  "type": "string"
                }
              }
            },
            "doc": "Items Ex point lists: an id and a title each."
          }
        }
      }
    ]
  }
}
```

File `client/index.ts`:
```ts
// Ex point's client half: a Settings section listing what other plugins add to its point, `ex-point.items`. React
// comes from the layer, through the plugin SDK, so the plugin ships none of its own.
import { createElement as h, useEffect, usePluginApi, useState } from "@waifucave/clover-plugin-sdk/ui";

interface Item {
  id: string;
  title: string;
}

export function ExPointSection() {
  const api = usePluginApi();
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    let live = true;
    void api.points.entries<Item>("ex-point.items").then((e) => { if (live) setItems(e.map((x) => x.value)); });
    const off = api.points.watch<Item>("ex-point.items", (e) => setItems(e.map((x) => x.value)));
    return () => { live = false; off(); };
  }, [api]);
  return h("ul", null, ...items.map((i) => h("li", { key: i.id }, i.title)));
}
```

File `README.md`:
```markdown
# Ex point

A point, `ex-point.items`: other plugins add entries to it under `contributes` in their own manifests (`"ex-point.items": [{ "id": "…", "title": "…" }]`), and this plugin's Settings section lists them.

Check it with `clover plugin validate`, and try it on this computer with `clover plugin dev .`.
```

### Example: A status-bar entry (a component in one of the shell's spots) (`ex-status`)

File `clover.json`:
```json
{
  "manifest": 1,
  "id": "ex-status",
  "name": "Ex status",
  "description": "A line in the status bar.",
  "engines": { "clover": "^1.0.0" },
  "client": { "entry": "client/index.ts" },
  "contributes": {
    "ui": [{ "spot": "status", "id": "line", "component": "StatusLine" }]
  }
}
```

File `client/index.ts`:
```ts
// The status bar's line: a component, drawn in the plugin's own layer where the shell shows its status bar.
import { createElement as h } from "@waifucave/clover-plugin-sdk/ui";

export function StatusLine() {
  return h("span", { style: { color: "var(--clover-color-text-muted)" } }, "Ex status is on");
}
```

### Example: A whole app (a sidebar button and its own page) (`ex-app`)

The `main` spot is keyed by route: a `main` entry whose `key` is your plugin's id is your app's page, and a
`sidebar.app` entry whose `opens` is that key puts its button in the sidebar: the sidebar draws the button from its
`title` and `icon` (an svg in the plugin), and its component is a badge beside it (a count, a dot), or nothing. The
page is a whole React tree of your own: state, lists, forms, your plugin's storage through its host half (plugin-ui,
plugin-host). This one also opens a video the user picks and plays it: the `files` capability, a pick on the user's
click, and the token's media URL (plugin-ui, "Files and media").

File `clover.json`:
```json
{
  "manifest": 1,
  "id": "ex-app",
  "name": "Ex app",
  "description": "An app inside Clover: a button in the sidebar opens its page, which plays a video you pick.",
  "engines": { "clover": "^1.0.0" },
  "capabilities": ["files"],
  "client": { "entry": "client/index.ts" },
  "contributes": {
    "ui": [
      { "spot": "main", "key": "ex-app", "component": "AppPage" },
      { "spot": "sidebar.app", "id": "open", "component": "AppBadge", "title": "Ex app", "icon": "assets/icon.svg", "opens": "ex-app" }
    ]
  }
}
```

File `client/index.ts`:
```ts
// The app's page (`main`, key ex-app) and its sidebar button's badge (`sidebar.app`, opens ex-app). The page opens a
// video the user picks (a token, never a path) and plays it from the token's media URL.
import { createElement as h, usePluginApi, useState } from "@waifucave/clover-plugin-sdk/ui";

export function AppPage() {
  const api = usePluginApi();
  const [video, setVideo] = useState<{ name: string; url: string } | null>(null);
  const [note, setNote] = useState("");
  const open = async () => {
    try {
      const r = await api.files!.pickOpen({ filters: [{ name: "Video", extensions: ["mp4", "webm", "mov"] }] });
      if ("cancelled" in r) return;
      const g = r.grants[0]!;
      setVideo({ name: g.name, url: api.files!.url(g.token) });
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err)); // a refused place says why
    }
  };
  return h("main", { style: { padding: "var(--clover-space-l)" } },
    h("h1", null, "Ex app"),
    h("button", { type: "button", onClick: () => void open() }, "Open a video"),
    note ? h("p", null, note) : null,
    video ? h("figure", null, h("video", { src: video.url, controls: true, style: { maxWidth: "100%" } }), h("figcaption", null, video.name)) : null,
  );
}

// No badge: the sidebar draws the button from the entry's title and icon.
export function AppBadge() {
  return null;
}
```

File `assets/icon.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="4"/></svg>
```

### Example: A UI spot of your own, and a plugin that fills it (`ex-board`)

A component declares a spot with `declares` on its `ui` entry: the name starts with the plugin's id and a dot, and a
declaration with `props` is a UI spot (without `props`, a data point: see the point example). The component draws
whatever fills it with `Spot`. Other plugins fill it with an ordinary `ui` entry: the next example.

File `clover.json`:
```json
{
  "manifest": 1,
  "id": "ex-board",
  "name": "Ex board",
  "description": "A board in Settings that shows the widgets other plugins add.",
  "engines": { "clover": "^1.0.0" },
  "client": { "entry": "client/index.ts" },
  "contributes": {
    "ui": [{
      "spot": "settings.section", "id": "board", "component": "Board", "title": "Ex board",
      "declares": {
        "ex-board.widgets": {
          "shape": "list",
          "props": { "type": "object", "properties": { "size": { "type": "string" } } },
          "doc": "Widgets on Ex board: each gets `size`."
        }
      }
    }]
  }
}
```

File `client/index.ts`:
```ts
// The board: draws every entry of its own spot, ex-board.widgets, handing each the props it declared.
import { createElement as h, Spot } from "@waifucave/clover-plugin-sdk/ui";

export function Board() {
  return h("section", null, h(Spot, { name: "ex-board.widgets", props: { size: "small" } }));
}
```

### Example: A plugin that fills another plugin's spot (`ex-board-widget`)

File `clover.json`:
```json
{
  "manifest": 1,
  "id": "ex-board-widget",
  "name": "Ex board widget",
  "description": "A widget on Ex board.",
  "engines": { "clover": "^1.0.0" },
  "client": { "entry": "client/index.ts" },
  "contributes": {
    "ui": [{ "spot": "ex-board.widgets", "id": "hello", "component": "Hello" }]
  }
}
```

File `client/index.ts`:
```ts
// One widget on Ex board: its props are what the board's Spot hands it.
import { createElement as h } from "@waifucave/clover-plugin-sdk/ui";

export function Hello({ props }: { props: { size?: string } }) {
  return h("p", null, `Hello from a ${props.size ?? "plain"} widget`);
}
```

### Example: A bot with its own tab, and a child plugin for UI outside it (`ex-buddy`)

A bot's plugin draws in its own tab's spots (`bot.header`, `bot.side`, `bot.stage`, `bot.controls`, …): each gets
`props.bot`, the bot it is drawn for. UI anywhere else (a Settings section, the status bar) goes in a child plugin,
in `plugins/<folder>/`, which one OK covers with its parent.

File `clover.json`:
```json
{
  "manifest": 1,
  "id": "ex-buddy",
  "name": "Ex buddy",
  "description": "A bot with a header and a side panel of its own.",
  "engines": { "clover": "^1.0.0" },
  "client": { "entry": "client/index.ts" },
  "contributes": {
    "bot": { "name": "Ex buddy", "instructions": "bot/instructions.md" },
    "ui": [
      { "spot": "bot.header", "id": "header", "component": "BuddyHeader" },
      { "spot": "bot.side", "id": "side", "component": "BuddySide" }
    ]
  }
}
```

File `bot/instructions.md`:
```markdown
You are Ex buddy, a cheerful study partner. Keep answers short and ask one question back.
```

File `client/index.ts`:
```ts
// Ex buddy's tab: its header and its side panel. Each is handed the bot it is drawn for.
import { createElement as h } from "@waifucave/clover-plugin-sdk/ui";

interface TabProps { props: { bot: { id: string; name: string | { en: string } } } }

const nameOf = (bot: TabProps["props"]["bot"]) => (typeof bot.name === "string" ? bot.name : bot.name.en);

export function BuddyHeader({ props }: TabProps) {
  return h("header", { style: { padding: "var(--clover-space-m)", fontWeight: 600 } }, nameOf(props.bot));
}

export function BuddySide() {
  return h("aside", { style: { padding: "var(--clover-space-m)", color: "var(--clover-color-text-muted)" } }, "Today: one page of notes.");
}
```

File `plugins/settings/clover.json`:
```json
{
  "manifest": 1,
  "name": "Ex buddy's settings",
  "engines": { "clover": "^1.0.0" },
  "client": { "entry": "client/index.ts" },
  "contributes": {
    "ui": [{ "spot": "settings.section", "id": "buddy", "component": "BuddySettings", "title": "Ex buddy" }]
  }
}
```

File `plugins/settings/client/index.ts`:
```ts
// A Settings section for Ex buddy: outside the bot's tab, so it lives in a child plugin.
import { createElement as h } from "@waifucave/clover-plugin-sdk/ui";

export function BuddySettings() {
  return h("p", null, "Ex buddy has nothing to set yet.");
}
```

### Example: An app whose tools drive its open page (`ex-timeline`)

One plugin, one host half serving both sides: the app's page (`main` + `sidebar.app`) and an MCP server whose tools
change the same project the page shows. The host half holds the timeline; each tool that changes it sends `changed`
to the page (`api.ui.send`), and the page redraws from it (`api.host.on`). `TimelineRead` is listed in `readOnly`, so
a bot reads without a card; adding, moving and removing raise the usual card at the default level. Every bot gets
these tools, and a tool serving a bot's call reaches what that bot can reach (plugin-host, "Tools that drive a page").
The page also adds a clip from a video the user picks: the token goes to the host half with the item, and the page
previews a clip from the token's media URL (plugin-ui, "Files and media"); an export would hand
`api.files.path(token)` to an encoder the host half starts (plugin-host, "Picked files"). The timeline is kept in
memory here; a real app keeps it in `api.storage.dataFolder`.

File `clover.json`:
```json
{
  "manifest": 1,
  "id": "ex-timeline",
  "name": "Ex timeline",
  "description": "A small timeline: its page shows the items, and its tools let a bot add, move and remove them.",
  "engines": { "clover": "^1.0.0" },
  "capabilities": ["files"],
  "host": { "entry": "host/index.ts", "runtime": "bun" },
  "client": { "entry": "client/index.ts" },
  "contributes": {
    "mcpServers": {
      "timeline": {
        "type": "host",
        "tools": { "*": "on-demand" },
        "readOnly": ["TimelineRead"]
      }
    },
    "ui": [
      { "spot": "main", "key": "ex-timeline", "component": "TimelinePage" },
      { "spot": "sidebar.app", "id": "open", "component": "TimelineBadge", "title": "Ex timeline", "icon": "assets/icon.svg", "opens": "ex-timeline" }
    ]
  }
}
```

File `host/index.ts`:
```ts
// Ex timeline's host half: the timeline itself, the page's calls (`ui`) and the bot's tools (`mcp.timeline`). Every
// change goes through `change`, which tells the page.
import type { HostModule, HostPluginApi, McpServerTransport } from "@waifucave/clover-plugin-sdk";

interface Item { id: string; title: string; start: number; length: number; source?: string }

let api: HostPluginApi | undefined;
let items: Item[] = [];
let next = 1;

export function start(a: HostPluginApi) {
  api = a;
}

function change(to: Item[]): Item[] {
  items = [...to].sort((a, b) => a.start - b.start);
  api?.ui.send("changed", { items });
  return items;
}

const num = (v: unknown, name: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`\`${name}\` is a number of seconds, 0 or more`);
  return v;
};

function add(a: { title?: unknown; start?: unknown; length?: unknown; source?: unknown }): Item {
  const item: Item = { id: `i${next++}`, title: String(a.title ?? "Untitled").slice(0, 200), start: num(a.start, "start"), length: num(a.length ?? 5, "length") };
  // A clip from a file the user picked: its token (`grant:<uuid>`), never a path.
  if (typeof a.source === "string" && a.source.startsWith("grant:")) item.source = a.source;
  change([...items, item]);
  return item;
}

function move(a: { id?: unknown; start?: unknown }): Item {
  const item = items.find((i) => i.id === a.id);
  if (!item) throw new Error(`no item ${String(a.id)}`);
  const moved = { ...item, start: num(a.start, "start") };
  change(items.map((i) => (i.id === moved.id ? moved : i)));
  return moved;
}

function remove(a: { id?: unknown }): void {
  if (!items.some((i) => i.id === a.id)) throw new Error(`no item ${String(a.id)}`);
  change(items.filter((i) => i.id !== a.id));
}

// What the page may call.
export const ui = {
  read: () => ({ items }),
  add: (args: unknown) => add((args ?? {}) as { title?: unknown; start?: unknown; length?: unknown; source?: unknown }),
};

const id = { type: "string", description: "The item's id, from TimelineRead." };
const seconds = { type: "number", minimum: 0, description: "Seconds from the timeline's start." };
const TOOLS = [
  { name: "TimelineRead", description: "Lists the timeline's items: id, title, start and length in seconds.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "TimelineAdd", description: "Adds an item to the timeline.", inputSchema: { type: "object", properties: { title: { type: "string" }, start: seconds, length: seconds }, required: ["title", "start"] } },
  { name: "TimelineMove", description: "Moves an item to a new start.", inputSchema: { type: "object", properties: { id, start: seconds }, required: ["id", "start"] } },
  { name: "TimelineRemove", description: "Removes an item.", inputSchema: { type: "object", properties: { id }, required: ["id"] } },
];

function call(name: unknown, args: Record<string, unknown>): string {
  if (name === "TimelineRead") return JSON.stringify(items);
  if (name === "TimelineAdd") return `Added ${JSON.stringify(add(args))}.`;
  if (name === "TimelineMove") return `Moved ${JSON.stringify(move(args))}.`;
  if (name === "TimelineRemove") { remove(args); return `Removed ${String(args.id)}.`; }
  throw new Error(`no tool ${String(name)}`);
}

export const mcp: HostModule["mcp"] = {
  timeline: async (transport: McpServerTransport) => {
    const reply = (id: unknown, body: Record<string, unknown>) => void transport.send({ jsonrpc: "2.0", id, ...body });
    transport.onmessage = (m) => {
      if (typeof m.id !== "number" && typeof m.id !== "string") return; // a notification: nothing to answer
      const p = (m.params ?? {}) as { name?: unknown; arguments?: Record<string, unknown> };
      if (m.method === "initialize") return reply(m.id, { result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ex-timeline", version: "0.1.0" } } });
      if (m.method === "ping") return reply(m.id, { result: {} });
      if (m.method === "tools/list") return reply(m.id, { result: { tools: TOOLS } });
      if (m.method === "tools/call") {
        try {
          return reply(m.id, { result: { content: [{ type: "text", text: call(p.name, p.arguments ?? {}) }] } });
        } catch (err) {
          return reply(m.id, { result: { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true } });
        }
      }
      reply(m.id, { error: { code: -32601, message: `unknown method ${String(m.method)}` } });
    };
    await transport.start();
  },
};
```

File `client/index.ts`:
```ts
// Ex timeline's page: reads the timeline from its host half once, then redraws on each `changed` the host half sends,
// whoever made the change (the user here, or a bot through the tools). A clip from a picked video keeps its token, and
// a click on it previews it from the token's media URL.
import { createElement as h, useEffect, usePluginApi, useState } from "@waifucave/clover-plugin-sdk/ui";

interface Item { id: string; title: string; start: number; length: number; source?: string }

export function TimelinePage() {
  const api = usePluginApi();
  const [items, setItems] = useState<Item[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api.host.call<{ items: Item[] }>("read").then((r) => { if (live) setItems(r.items); });
    const off = api.host.on("changed", (data) => setItems((data as { items: Item[] }).items));
    return () => { live = false; off(); };
  }, [api]);
  const end = Math.max(10, ...items.map((i) => i.start + i.length));
  const fromFile = async () => {
    const r = await api.files!.pickOpen({ filters: [{ name: "Video", extensions: ["mp4", "webm", "mov"] }] });
    if ("cancelled" in r) return;
    for (const g of r.grants) await api.host.call("add", { title: g.name, start: end, length: 5, source: g.token });
  };
  return h("main", { style: { padding: "var(--clover-space-l)" } },
    h("h1", null, "Ex timeline"),
    h("button", { type: "button", onClick: () => void api.host.call("add", { title: "New clip", start: end, length: 5 }) }, "Add a clip"),
    h("button", { type: "button", onClick: () => void fromFile() }, "Add a clip from a video"),
    preview ? h("video", { src: preview, controls: true, style: { display: "block", maxWidth: "100%" } }) : null,
    h("div", { style: { position: "relative", height: "48px", marginTop: "var(--clover-space-m)", background: "var(--clover-color-surface)" } },
      ...items.map((i) => h("div", {
        key: i.id,
        title: `${i.title}: ${i.start}s for ${i.length}s`,
        onClick: () => setPreview(i.source ? api.files!.url(i.source) : null),
        style: {
          position: "absolute", top: 0, bottom: 0, left: `${(i.start / end) * 100}%`, width: `${(i.length / end) * 100}%`,
          background: "var(--clover-color-accent)", color: "var(--clover-color-accent-contrast)", overflow: "hidden",
        },
      }, i.title)),
    ),
  );
}

// No badge: the sidebar draws the button from the entry's title and icon.
export function TimelineBadge() {
  return null;
}
```

File `assets/icon.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M7 8v8M12 6v12M17 9v6"/></svg>
```
