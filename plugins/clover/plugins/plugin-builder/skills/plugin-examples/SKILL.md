---
name: plugin-examples
description: Minimal working Clover plugins to copy - a tool, a settings section, a status-bar entry, a whole app (sidebar button plus its own page), an app whose tools let a bot drive its open page, a theme, a bot, a bot with its own tab and a child plugin, a model provider, a trigger, a data point other plugins fill, a UI spot of your own that another plugin fills, and a page that fits the space it gets. Each one is checked by Clover's validator and loaded through the registry in its tests.
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
plugin-host). This one also plays a video the user picks or drops on the page: the `files` capability, a pick on the
user's click or a drop, and the token's media URL (plugin-ui, "Files and media").

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
// The app's page (`main`, key ex-app) and its sidebar button's badge (`sidebar.app`, opens ex-app). The page plays a
// video the user picks or drops on it (a token, never a path) from the token's media URL.
import { createElement as h, useEffect, usePluginApi, useState } from "@waifucave/clover-plugin-sdk/ui";

export function AppPage() {
  const api = usePluginApi();
  const [video, setVideo] = useState<{ name: string; url: string } | null>(null);
  const [note, setNote] = useState("");
  // Drops: the page takes them by cancelling dragover, and gets tokens like a pick's.
  useEffect(() => {
    const over = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", over);
    const off = api.files!.onDrop!((grants, refused) => {
      const g = grants.find((x) => x.kind === "file");
      if (g) setVideo({ name: g.name, url: api.files!.url!(g.token) });
      else if (refused) setNote(refused);
    });
    return () => { window.removeEventListener("dragover", over); off(); };
  }, [api]);
  const open = async () => {
    try {
      const r = await api.files!.pickOpen!({ filters: [{ name: "Video", extensions: ["mp4", "webm", "mov"] }] });
      if ("cancelled" in r) return;
      const g = r.grants[0]!;
      setVideo({ name: g.name, url: api.files!.url!(g.token) });
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err)); // a refused place says why
    }
  };
  return h("main", { style: { padding: "var(--clover-space-l)" } },
    h("h1", null, "Ex app"),
    h("button", { type: "button", onClick: () => void open() }, "Open a video"),
    h("p", null, "…or drop one here."),
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

The whole shape of an app such as a video editor, small. One plugin, one host half serving both sides: the app's page
(`main` + `sidebar.app`) and an MCP server whose tools change the same project the page shows. The host half holds the
timeline; each change sends `changed` to the page (`api.ui.send`), and the page redraws from it (`api.host.on`),
whoever made the change. `TimelineRead` is listed in `readOnly`, so a bot reads without a card; adding, moving and
removing raise the usual card at the default level. Every bot gets these tools, and a tool serving a bot's call reaches
what that bot can reach (plugin-host, "Tools that drive a page").

What the page shows of the rest (plugin-ui, "An app like a video editor"):

- the user's videos: a pick on their click (`files.pickOpen`) or a drop on the page (`files.onDrop`) gives tokens,
  never paths; a clip keeps its token, and a click on it previews it from the token's media URL (`files.url`);
- export: a save pick (`files.pickSave`), then the host half renders the video with ffmpeg on the picks' real paths
  (`files.path`; `"programs": true`, plugin-host "Programs"), each clip trimmed to its length with its filters; or the
  edit list (each clip, its time and its filters) written on the token (`files.write`). A pick replaces the host's
  process once no call is running, so the timeline is kept in the synced store, never in memory alone;
- add-ons: the page declares a point, `ex-timeline.effects`, which effect plugins fill with a title and a host export
  (`"format": "handler"`); the page lists them (`points.entries`, `points.watch`) and runs one on the chosen clip
  (`points.call`), which answers an ffmpeg filter the clip keeps;
- asking first: clearing the timeline asks the user (`confirm`).

A real app keeps a large project in its data folder; this one is small enough for the synced store.

File `clover.json`:
```json
{
  "manifest": 1,
  "id": "ex-timeline",
  "name": "Ex timeline",
  "description": "A small timeline: its page shows the clips, and its tools let a bot add, move and remove them.",
  "engines": { "clover": "^1.0.0" },
  "capabilities": ["files"],
  "host": { "entry": "host/index.ts", "runtime": "bun", "process": "own", "programs": true },
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
      {
        "spot": "main", "key": "ex-timeline", "component": "TimelinePage",
        "declares": {
          "ex-timeline.effects": {
            "shape": "list",
            "fields": {
              "type": "object",
              "required": ["id", "title", "apply"],
              "properties": {
                "id": { "type": "string" },
                "title": { "type": "string" },
                "apply": { "type": "string", "format": "handler", "description": "Takes { clip } and answers { filter }, an ffmpeg filter." }
              }
            },
            "doc": "Effects for Ex timeline's clips: a title, and the host export that answers the clip's ffmpeg filter."
          }
        }
      },
      { "spot": "sidebar.app", "id": "open", "component": "TimelineBadge", "title": "Ex timeline", "icon": "assets/icon.svg", "opens": "ex-timeline" }
    ]
  }
}
```

File `host/index.ts`:
```ts
// Ex timeline's host half: the timeline itself, the page's calls (`ui`) and the bot's tools (`mcp.timeline`). Every
// change goes through `change`, which keeps it in the synced store (a pick replaces this process) and tells the page.
import type { HostModule, HostPluginApi, McpServerTransport } from "@waifucave/clover-plugin-sdk";

interface Item { id: string; title: string; start: number; length: number; source?: string; filters?: string[] }

let api: HostPluginApi | undefined;
let items: Item[] = [];
let next = 1;

export async function start(a: HostPluginApi) {
  api = a;
  const kept = await a.storage.synced.get<{ items: Item[]; next: number }>("timeline");
  if (kept) ({ items, next } = kept);
}

function change(to: Item[]): Item[] {
  items = [...to].sort((a, b) => a.start - b.start);
  void api?.storage.synced.set("timeline", { items, next });
  api?.ui.send("changed", { items });
  return items;
}

const num = (v: unknown, name: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`\`${name}\` is a number of seconds, 0 or more`);
  return v;
};

function add(a: { title?: unknown; start?: unknown; length?: unknown; source?: unknown }): Item {
  const item: Item = { id: `i${next++}`, title: String(a.title ?? "Untitled").slice(0, 200), start: num(a.start, "start"), length: num(a.length ?? 5, "length") };
  // A clip from a file the user picked or dropped: its token (`grant:<uuid>`), never a path.
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

// An effect's answer, kept on its clip: an ffmpeg filter such as `hue=s=0` (letters, digits and = : , . only).
function filter(a: { id?: unknown; filter?: unknown }): Item {
  const item = items.find((i) => i.id === a.id);
  if (!item) throw new Error(`no item ${String(a.id)}`);
  if (typeof a.filter !== "string" || !/^[A-Za-z0-9=:,.]{1,200}$/.test(a.filter)) throw new Error("an effect answered no filter");
  const changed = { ...item, filters: [...(item.filters ?? []), a.filter] };
  change(items.map((i) => (i.id === changed.id ? changed : i)));
  return changed;
}

// The edit list the page exports: one line per clip, its time, its source's token and its filters.
function editList(): string {
  return items.map((i) => [i.start, i.length, i.title, i.source ?? "-", (i.filters ?? []).join(",") || "-"].join("\t")).join("\n") + "\n";
}

// The video itself (`host.programs`): ffmpeg on the clips' real paths, each trimmed to its length with its filters,
// joined, into the save pick the page passes. The user's picks are all the program may read and write.
async function render(a: { output?: unknown }): Promise<{ rendered: number }> {
  const files = api?.files;
  if (files === undefined) throw new Error("the files capability isn't granted");
  if (typeof a.output !== "string" || !a.output.startsWith("grant:")) throw new Error("render takes the save pick's token as `output`");
  const clips = items.filter((i): i is Item & { source: string } => i.source !== undefined);
  if (clips.length === 0) throw new Error("no clip from a video to render");
  if (Bun.which("ffmpeg") === null) throw new Error("ffmpeg isn't installed on this computer");
  const inputs = await Promise.all(clips.map((c) => files.path(c.source)));
  const output = await files.path(a.output);
  const graph = clips.map((c, n) => `[${n}:v]trim=duration=${c.length},setpts=PTS-STARTPTS${(c.filters ?? []).map((f) => `,${f}`).join("")}[v${n}]`).join(";")
    + `;${clips.map((_, n) => `[v${n}]`).join("")}concat=n=${clips.length}:v=1:a=0[out]`;
  const ffmpeg = Bun.spawn(["ffmpeg", "-y", ...inputs.flatMap((p) => ["-i", p]), "-filter_complex", graph, "-map", "[out]", output], { stdout: "ignore", stderr: "pipe" });
  if ((await ffmpeg.exited) !== 0) throw new Error(`ffmpeg stopped: ${(await new Response(ffmpeg.stderr).text()).trim().split("\n").pop() ?? ""}`);
  return { rendered: clips.length };
}

// What the page may call.
export const ui = {
  read: () => ({ items }),
  add: (args: unknown) => add((args ?? {}) as { title?: unknown; start?: unknown; length?: unknown; source?: unknown }),
  filter: (args: unknown) => filter((args ?? {}) as { id?: unknown; filter?: unknown }),
  editList: () => ({ text: editList() }),
  clear: () => { change([]); return { cleared: true }; },
  render: (args: unknown) => render((args ?? {}) as { output?: unknown }),
};

const id = { type: "string", description: "The item's id, from TimelineRead." };
const seconds = { type: "number", minimum: 0, description: "Seconds from the timeline's start." };
const TOOLS = [
  { name: "TimelineRead", description: "Lists the timeline's items: id, title, start and length in seconds, and filters.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
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
// whoever made the change (the user here, or a bot through the tools). Videos come in by a pick or a drop (tokens,
// never paths) and preview from the token's media URL; effects come from other plugins through the page's own point;
// the edit list goes out through a save pick; clearing asks the user first.
import { createElement as h, useEffect, usePluginApi, useState } from "@waifucave/clover-plugin-sdk/ui";

interface Item { id: string; title: string; start: number; length: number; source?: string; filters?: string[] }
interface Effect { id: string; title: string }
interface Grant { token: string; name: string; kind: "file" | "folder" }

const VIDEO = [{ name: "Video", extensions: ["mp4", "webm", "mov"] }];

export function TimelinePage() {
  const api = usePluginApi();
  const [items, setItems] = useState<Item[]>([]);
  const [effects, setEffects] = useState<{ pluginId: string; entryId: string; value: Effect }[]>([]);
  const [chosen, setChosen] = useState<Item | null>(null);
  const [note, setNote] = useState("");
  const end = Math.max(10, ...items.map((i) => i.start + i.length));
  const addClips = async (grants: Grant[], at: number) => {
    let t = at;
    for (const g of grants.filter((x) => x.kind === "file")) { await api.host.call("add", { title: g.name, start: t, length: 5, source: g.token }); t += 5; }
  };
  useEffect(() => {
    let live = true;
    void api.host.call<{ items: Item[] }>("read").then((r) => { if (live) setItems(r.items); });
    const offChanged = api.host.on("changed", (data) => setItems((data as { items: Item[] }).items));
    // The effects other plugins add: only those of plugins the user OK'd and that run, with the fields declared.
    void api.points.entries<Effect>("ex-timeline.effects").then((e) => { if (live) setEffects(e); }).catch(() => undefined);
    const offEffects = api.points.watch<Effect>("ex-timeline.effects", setEffects);
    // Drops: the page takes them by cancelling dragover, and gets tokens like a pick's.
    const over = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", over);
    const offDrop = api.files!.onDrop!((grants, refused) => { if (refused) setNote(refused); void addClips(grants, end); });
    return () => { live = false; offChanged(); offEffects(); window.removeEventListener("dragover", over); offDrop(); };
  }, [api]);
  const fromFile = async () => {
    const r = await api.files!.pickOpen!({ multiple: true, filters: VIDEO });
    if (!("cancelled" in r)) await addClips(r.grants, end);
  };
  const applyEffect = async (e: { pluginId: string; entryId: string }) => {
    if (!chosen) return setNote("Choose a clip first.");
    // Runs the effect plugin's own host export, named by its entry's `apply`.
    const r = await api.points.call<{ filter: string }>("ex-timeline.effects", e, "apply", { clip: chosen });
    await api.host.call("filter", { id: chosen.id, filter: r.filter });
  };
  const exportList = async () => {
    const r = await api.files!.pickSave!({ suggestedName: "timeline.txt", filters: [{ name: "Edit list", extensions: ["txt"] }] });
    if ("cancelled" in r) return;
    const { text } = await api.host.call<{ text: string }>("editList");
    await api.files!.write!(r.grants[0]!.token, text);
    setNote(`Saved ${r.grants[0]!.name}.`);
  };
  const renderVideo = async () => {
    // The output first: a pick replaces the host's process once it is idle, so the job starts after it.
    const r = await api.files!.pickSave!({ suggestedName: "timeline.mp4", filters: [{ name: "Video", extensions: ["mp4"] }] });
    if ("cancelled" in r) return;
    setNote("Rendering…");
    try {
      const done = await api.host.call<{ rendered: number }>("render", { output: r.grants[0]!.token }, { timeoutMs: 600_000 });
      setNote(`Rendered ${done.rendered} clip(s) into ${r.grants[0]!.name}.`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    }
  };
  const clear = async () => {
    if (await api.confirm("Remove every clip from Ex timeline?")) await api.host.call("clear");
  };
  return h("main", { style: { padding: "var(--clover-space-l)" } },
    h("h1", null, "Ex timeline"),
    h("button", { type: "button", onClick: () => void api.host.call("add", { title: "New clip", start: end, length: 5 }) }, "Add a clip"),
    h("button", { type: "button", onClick: () => void fromFile() }, "Add videos…"),
    h("button", { type: "button", onClick: () => void renderVideo() }, "Render the video…"),
    h("button", { type: "button", onClick: () => void exportList() }, "Export the edit list…"),
    h("button", { type: "button", onClick: () => void clear() }, "Clear"),
    h("p", null, note || "Drop videos here to add them."),
    ...effects.map((e) => h("button", { key: `${e.pluginId}/${e.entryId}`, type: "button", onClick: () => void applyEffect(e) }, e.value.title)),
    chosen?.source ? h("video", { src: api.files!.url!(chosen.source), controls: true, style: { display: "block", maxWidth: "100%" } }) : null,
    h("div", { style: { position: "relative", height: "48px", marginTop: "var(--clover-space-m)", background: "var(--clover-color-surface)" } },
      ...items.map((i) => h("div", {
        key: i.id,
        title: `${i.title}: ${i.start}s for ${i.length}s${i.filters ? `, ${i.filters.join(", ")}` : ""}`,
        onClick: () => setChosen(i),
        style: {
          position: "absolute", top: 0, bottom: 0, left: `${(i.start / end) * 100}%`, width: `${(i.length / end) * 100}%`,
          background: "var(--clover-color-accent)", color: "var(--clover-color-accent-contrast)", overflow: "hidden",
          outline: chosen?.id === i.id ? "2px solid var(--clover-color-text)" : "none",
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

### Example: A page that fits its space, and tiles another plugin fills (`ex-fit`)

The page measures its own frame (plugin-ui, "Fitting the space you get"): two columns when it is 640 px wide or more,
one under the other below that. It declares a spot of its own, `ex-fit.tiles`, gives each tile a box of a fixed height
from its stylesheet, and passes each one a `compact` prop. The next example fills it.

File `clover.json`:
```json
{
  "manifest": 1,
  "id": "ex-fit",
  "name": "Ex fit",
  "description": "A page that changes its layout with its width, and holds tiles other plugins add.",
  "engines": { "clover": "^1.0.0" },
  "client": { "entry": "client/index.ts", "css": ["client/styles.css"] },
  "contributes": {
    "ui": [
      {
        "spot": "main", "key": "ex-fit", "component": "FitPage",
        "declares": {
          "ex-fit.tiles": {
            "shape": "list",
            "props": { "type": "object", "properties": { "compact": { "type": "boolean" } } },
            "doc": "Tiles on Ex fit's page, each in a box 72 px high; `compact` when the page is narrow."
          }
        }
      },
      { "spot": "sidebar.app", "id": "open", "component": "FitBadge", "title": "Ex fit", "icon": "assets/icon.svg", "opens": "ex-fit" }
    ]
  }
}
```

File `client/styles.css`:
```css
/* Each tile's frame gets a box 72 px high (a Spot adds no element, so the frame is the slot's own child). */
.ex-fit-slot > iframe { height: 72px !important; }
.ex-fit-slot { border-radius: var(--clover-radius-medium); background: var(--clover-color-surface); overflow: hidden; }
```

File `client/index.ts`:
```ts
// Ex fit's page: its layout follows its own frame's width (two columns from 640 px, one below), and its tiles come
// from other plugins through its own spot, each in a box whose height the stylesheet sets.
import { createElement as h, Spot, useEffect, useState } from "@waifucave/clover-plugin-sdk/ui";

/** This frame's own size: its document's box, which is all a part can measure. */
function useOwnBox(): { width: number; height: number } {
  const read = () => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight });
  const [box, setBox] = useState(read);
  useEffect(() => {
    const ro = new ResizeObserver(() => setBox(read()));
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, []);
  return box;
}

export function FitPage() {
  const { width } = useOwnBox();
  const wide = width >= 640;
  return h("main", { style: { padding: "var(--clover-space-l)" } },
    h("h1", null, "Ex fit"),
    h("div", { style: { display: "grid", gap: "var(--clover-space-m)", gridTemplateColumns: wide ? "minmax(0, 2fr) minmax(0, 1fr)" : "minmax(0, 1fr)" } },
      h("section", null, h("p", null, wide ? "Wide: the notes sit beside the tiles." : "Narrow: the notes come under the tiles.")),
      h("aside", { style: { display: "grid", gap: "var(--clover-space-s)" } },
        h("div", { className: "ex-fit-slot" }, h(Spot, { name: "ex-fit.tiles", props: { compact: !wide } })),
      ),
    ),
  );
}

// No badge: the sidebar draws the button from the entry's title and icon.
export function FitBadge() {
  return null;
}
```

File `assets/icon.svg`:
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="11" height="16" rx="2"/><rect x="16" y="4" width="5" height="16" rx="2"/></svg>
```

### Example: A tile that frames itself by its own box (`ex-fit-tile`)

A plugin filling `ex-fit.tiles`. Its frame is the box Ex fit's stylesheet gives it, so it measures that box and leaves
out its second line when the box is too short for it, and its detail when the page says `compact`.

File `clover.json`:
```json
{
  "manifest": 1,
  "id": "ex-fit-tile",
  "name": "Ex fit tile",
  "description": "A tile on Ex fit's page.",
  "engines": { "clover": "^1.0.0" },
  "client": { "entry": "client/index.ts" },
  "contributes": {
    "ui": [{ "spot": "ex-fit.tiles", "id": "weather", "component": "WeatherTile" }]
  }
}
```

File `client/index.ts`:
```ts
// A tile in a box its host sizes: what fits is decided by its own box's height (and the host's `compact`), never by
// the window, which a part can't see.
import { createElement as h, useEffect, useState } from "@waifucave/clover-plugin-sdk/ui";

function useOwnHeight(): number {
  const [height, setHeight] = useState(() => document.documentElement.clientHeight);
  useEffect(() => {
    const ro = new ResizeObserver(() => setHeight(document.documentElement.clientHeight));
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, []);
  return height;
}

export function WeatherTile({ props }: { props: { compact?: boolean } }) {
  const height = useOwnHeight();
  const room = height >= 56;
  return h("div", { style: { padding: "var(--clover-space-s)", color: "var(--clover-color-text)" } },
    h("strong", null, "Sunny, 21°"),
    room ? h("div", { style: { color: "var(--clover-color-text-muted)" } }, props.compact ? "Light wind" : "Light wind from the west, dry all afternoon") : null,
  );
}
```

