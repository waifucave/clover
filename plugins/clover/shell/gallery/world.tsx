// A pretend world for the whole-window screens: every part's manifest read as the runtime reads it, each component
// from its part's client module, and a mock core and plugin API answering from the parts' own fixtures. A screen
// mounts `<Spot name="app.root">` in it, so what shows is the default shell on the runtime, each spot filled by the
// entry the resolution rules pick, exactly as lane E's runtime will mount it.
//
// The world counts the calls still in flight, so the gallery says it is ready only once every screen has drawn its
// data (`whenIdle`).
import archiveManifest from "../../archive/clover.json";
import * as archiveClient from "../../archive/client/index";
import { ARCHIVED, HISTORY as ARCHIVE_HISTORY } from "../../archive/gallery/fixtures";
import botEditorManifest from "../../bot-editor/clover.json";
import * as botEditorClient from "../../bot-editor/client/index";
import { AVATARS } from "../../bot-editor/gallery/fixtures";
import composerManifest from "../../composer/clover.json";
import * as composerClient from "../../composer/client/index";
import { MODELS } from "../../composer/gallery/stories";
import conversationManifest from "../../conversation/clover.json";
import * as conversationClient from "../../conversation/client/index";
import type { CoreEvent } from "../../conversation/client/project";
import type { ConversationItem } from "../../conversation/client/types";
import { SEALED_CARDS } from "../../conversation/gallery/fixtures";
import { mockSealed } from "../../conversation/gallery/mock-runtime";
import panelDiffManifest from "../../panel-diff/clover.json";
import * as panelDiffClient from "../../panel-diff/client/index";
import { FILES } from "../../panel-diff/gallery/fixtures";
import panelFilesManifest from "../../panel-files/clover.json";
import * as panelFilesClient from "../../panel-files/client/index";
import { LISTING, OPEN_FILE, ROOT } from "../../panel-files/gallery/fixtures";
import panelTerminalManifest from "../../panel-terminal/clover.json";
import * as panelTerminalClient from "../../panel-terminal/client/index";
import { FEED } from "../../panel-terminal/gallery/fixtures";
import panelManifest from "../../panel/clover.json";
import * as panelClient from "../../panel/client/index";
import { SESSION as SESSION_COLUMN } from "../../panel/gallery/fixtures";
import pluginIndexManifest from "../../plugin-index/clover.json";
import * as pluginIndexClient from "../../plugin-index/client/index";
import { ENTRIES as INDEX_ENTRIES, INDEXES } from "../../plugin-index/gallery/fixtures";
import settingsManifest from "../../settings/clover.json";
import * as settingsClient from "../../settings/client/index";
import { LOG_LINES, VALUES as SETTINGS } from "../../settings/gallery/fixtures";
import sidebarManifest from "../../sidebar/clover.json";
import * as sidebarClient from "../../sidebar/client/index";
import { portrait } from "../../sidebar/gallery/fixtures";
import shellManifest from "../clover.json";
import * as shellClient from "../client/index";
import { SPOT_DECLS } from "../runtime/catalog";
import type { UiEntry } from "../runtime/resolve";
import type {
  BotView, CardMeta, ComputerView, CoreClient, CoreMethods, DeviceView, EntryComponent, PluginApi, PluginSummary, PointEntry, SessionView,
} from "../runtime/types";
import { card, computerView, deviceView, fakeApi, pluginDetail, pluginSummary, uiPluginView } from "../runtime/testkit";
import { runtimeWith, type UiRuntime } from "../runtime/ui";

// -------------------------------------------------------------------------------------------------
// The parts, as the runtime reads them
// -------------------------------------------------------------------------------------------------

interface Manifest {
  capabilities?: string[];
  contributes: { ui: Record<string, unknown>[] };
}

const PARTS: { dir: string; manifest: Manifest; client: Record<string, unknown> }[] = [
  { dir: "shell", manifest: shellManifest as Manifest, client: shellClient },
  { dir: "sidebar", manifest: sidebarManifest as Manifest, client: sidebarClient },
  { dir: "conversation", manifest: conversationManifest as Manifest, client: conversationClient },
  { dir: "composer", manifest: composerManifest as Manifest, client: composerClient },
  { dir: "panel", manifest: panelManifest as Manifest, client: panelClient },
  { dir: "panel-terminal", manifest: panelTerminalManifest as Manifest, client: panelTerminalClient },
  { dir: "panel-diff", manifest: panelDiffManifest as Manifest, client: panelDiffClient },
  { dir: "panel-files", manifest: panelFilesManifest as Manifest, client: panelFilesClient },
  { dir: "settings", manifest: settingsManifest as Manifest, client: settingsClient },
  { dir: "bot-editor", manifest: botEditorManifest as Manifest, client: botEditorClient },
  { dir: "plugin-index", manifest: pluginIndexManifest as Manifest, client: pluginIndexClient },
  { dir: "archive", manifest: archiveManifest as Manifest, client: archiveClient },
];

/** A `ui` entry's own keys; the rest are its spot's fields (title, icon, opens…). */
const UI_KEYS = new Set(["spot", "id", "key", "order", "when", "component", "web", "style", "hide", "window", "declares"]);

/** A part's `ui` entries as the runtime holds them. */
export function entriesOf(pluginId: string, manifest: Manifest, source: UiEntry["source"] = "bundled"): UiEntry[] {
  return manifest.contributes.ui.map((ui) => {
    const fields = Object.fromEntries(Object.entries(ui).filter(([k]) => !UI_KEYS.has(k)));
    return {
      pluginId,
      id: typeof ui.id === "string" ? ui.id : (ui.spot as string),
      spot: ui.spot as string,
      ...(typeof ui.key === "string" ? { key: ui.key } : {}),
      ...(typeof ui.order === "number" ? { order: ui.order } : {}),
      ...(ui.when ? { when: ui.when as UiEntry["when"] } : {}),
      ...(typeof ui.component === "string" ? { component: ui.component } : {}),
      ...(ui.hide === true ? { hide: true } : {}),
      ...(Object.keys(fields).length ? { fields } : {}),
      source,
      enabledAt: 0,
    };
  });
}

export const BUNDLED: { pluginId: string; capabilities: string[]; entries: UiEntry[]; client: Record<string, unknown> }[] = PARTS.map((p) => ({
  pluginId: `clover/${p.dir}`,
  capabilities: p.manifest.capabilities ?? [],
  entries: entriesOf(`clover/${p.dir}`, p.manifest),
  client: p.client,
}));

// -------------------------------------------------------------------------------------------------
// In flight
// -------------------------------------------------------------------------------------------------

let pending = 0;
const idleWaiters = new Set<() => void>();

function track<T>(p: Promise<T>): Promise<T> {
  pending++;
  const done = () => {
    pending--;
    if (pending === 0) setTimeout(() => pending === 0 && idleWaiters.forEach((w) => w()), 30);
  };
  p.then(done, done);
  return p;
}

/** Resolves once no world call has been in flight for a moment. */
export function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (pending > 0) return;
      idleWaiters.delete(check);
      resolve();
    };
    idleWaiters.add(check);
    setTimeout(check, 60);
  });
}

const later = <T,>(value: T): Promise<T> => track(new Promise((r) => setTimeout(() => r(value), 0)));
const fail = (message: string): Promise<never> => track(new Promise((_r, reject) => setTimeout(() => reject(new Error(message)), 0)));

// -------------------------------------------------------------------------------------------------
// The data
// -------------------------------------------------------------------------------------------------

/** Thursday, November 5, 2026, 16:30 UTC: every fixture's clock. */
export const NOW = Date.UTC(2026, 10, 5, 16, 30);

const bot = (id: string, name: string, extra: Partial<BotView> = {}): BotView => ({ id, name, model: "openai/gpt-6", effort: "medium", userLayer: [], state: "idle", computer: "Studio", mainSession: `s_${id}`, ...extra });

export const BOTS: BotView[] = [
  bot("alpha", "Alpha", { portrait: portrait("A", "#8ccbf0", "#3d7fb0"), state: "thinking", voice: { provider: "Fish Audio", voice: "Alpha" }, theme: "alpha#alpha-tab", userLayer: ["theme"] }),
  bot("luna", "Luna", { portrait: portrait("L", "#c9a7f2", "#6f4ab0") }),
  bot("juniper", "Juniper"),
  bot("mira", "Mira", { portrait: portrait("M", "#f6b8a0", "#b0583d") }),
];

const session = (id: string, extra: Partial<SessionView>): SessionView => ({ id, kind: "agent", computer: "Studio", status: "idle", startedAt: NOW - 3_600_000, updatedAt: NOW - 600_000, ...extra });

export const SESSIONS: SessionView[] = [
  session("s_alpha", { kind: "bot", bot: "alpha", model: "openai/gpt-6", effort: "medium" }),
  session("s_luna", { kind: "bot", bot: "luna", needsYou: { cards: 1, questions: 1 } }),
  session("s_juniper", { kind: "bot", bot: "juniper" }),
  session("s_mira", { kind: "bot", bot: "mira" }),
  session("agent-export", { parent: "s_alpha", bot: "alpha", backend: "Codex", title: "Fix the CSV export's dates", status: "prompting", model: "openai/gpt-6", effort: "medium", root: "home/Studio/projects/garden-planner" }),
  session("task-digest", { kind: "side-thread", parent: "s_alpha", bot: "alpha", title: "Weekly notes digest" }),
  session("agent-lint", { parent: "s_alpha", bot: "alpha", backend: "OpenCode", computer: "Laptop", title: "Fix the lint warnings", status: "prompting", needsYou: { cards: 1, questions: 0 } }),
  session("session-panels", { kind: "coding", backend: "Codex", title: "The panels as plugins", root: ROOT, status: "idle", model: "openai/gpt-6", effort: "high" }),
  session("session-hub", { kind: "coding", backend: "Codex", title: "Hub migrations on staging", root: ROOT, needsYou: { cards: 1, questions: 0 } }),
  session("session-docs", { kind: "coding", backend: "Claude Code", title: "README for the plugin index", root: ROOT }),
  session("session-spread", { kind: "coding", backend: "Codex", computer: "Laptop", title: "Three-card spread layout", root: "home/Laptop/code/tarot-panel" }),
  session("session-icons", { kind: "coding", backend: "Codex", computer: "Laptop", title: "Card icons at every size", root: "home/Laptop/code/tarot-panel", status: "failed" }),
];

const COMPUTERS: ComputerView[] = [
  computerView("Studio", { device: "dev_studio", level: "ask-risky", link: "self", isMain: true, agents: ["codex"] }),
  computerView("Laptop", { device: "dev_laptop", level: "ask", link: "lan", agents: ["opencode"] }),
  computerView("Cloud computer", { device: "dev_cloud", os: "linux", hasDisplay: false, level: "automatic", link: "relay" }),
];

/** The devices, by the ids the conversation's fixtures use. */
const DEVICE_IDS: Record<string, string> = { d1: "dev_studio", d2: "dev_laptop", d3: "dev_iphone" };
const DEVICES: DeviceView[] = SETTINGS.devices.map((d, i) =>
  deviceView(DEVICE_IDS[d.id] ?? d.id, d.name, { kind: d.kind === "computer" ? "desktop" : d.kind === "web" ? "browser" : "phone", runsCore: d.kind === "computer", isThis: d.here === true, isMain: d.main === true, addedAt: NOW - (i + 1) * 86_400_000 }),
);

const SOURCE_OF: Record<string, PluginSummary["source"]> = { Bundled: "bundled", "From the plugin index": "index" };
const dataPlugin = (id: string, name: string, source: PluginSummary["source"]): PluginSummary => pluginSummary(id, name, { source, class: "data" });
const PLUGINS: PluginSummary[] = [
  ...SETTINGS.plugins.map((p) => pluginSummary(p.id, p.name, { state: p.state, enabled: p.enabled, ...(p.reason ? { reason: p.reason } : {}), source: SOURCE_OF[p.source] ?? "local" })),
  // The bot, the avatar packs and the theme the bot editor's screen shows.
  dataPlugin("alpha", "Alpha", "bundled"),
  dataPlugin("chibi-pack", "Chibi pack", "index"),
  dataPlugin("paper-dolls", "Paper dolls", "index"),
  dataPlugin("midnight", "Midnight", "index"),
];
const CAPABILITIES: Record<string, { capabilities: string[]; networkHosts: string[] }> = {
  clover: { capabilities: ["conversation.read", "bots.read", "approvals", "files", "terminal"], networkHosts: [] },
  "tarot-panel": { capabilities: ["conversation.read"], networkHosts: [] },
  "weather-routine": { capabilities: ["notify", "network:api.weather.example"], networkHosts: ["api.weather.example"] },
  "story-mode": { capabilities: ["conversation.read", "audio"], networkHosts: [] },
  alpha: { capabilities: ["memory.read", "routines.read"], networkHosts: [] },
};

// -------------------------------------------------------------------------------------------------
// A conversation's items as the core's events (the projector's inverse, for the fixtures)
// -------------------------------------------------------------------------------------------------

export function toEvents(items: readonly ConversationItem[], running = false): CoreEvent[] {
  const out: CoreEvent[] = [];
  let seq = 0;
  const push = (type: string, ts: number, extra: Record<string, unknown> = {}) => out.push({ type, seq: ++seq, ts, ...extra });
  for (const it of items) {
    switch (it.kind) {
      case "user":
        push("user_message", it.at, { text: it.text, ...(it.device ? { device: it.device.id } : {}) });
        break;
      case "bot":
        push("assistant_message", it.at, { text: it.text });
        break;
      case "thinking":
        push("thinking_block", it.at, { blockId: it.id, kind: it.reasoning, ...(it.title ? { title: it.title } : {}), text: it.text ?? "", ...(it.durationMs ? { durationMs: it.durationMs } : {}) });
        break;
      case "tool": {
        const c = it.call;
        push("tool_call", it.at, { callId: c.callId, name: c.name, ...(c.detail ? { argsJson: JSON.stringify({ command: c.detail }) } : {}), ...(c.computer ? { computer: c.computer } : {}) });
        if (c.status === "succeeded" || c.status === "failed") push("tool_result", it.at, { callId: c.callId, output: c.output ?? "", isError: c.status === "failed", ...(c.diff ? { fileDiff: c.diff } : {}), ...(c.sites ? { siteIcons: c.sites } : {}) });
        break;
      }
      case "approval":
        push("card_pending", it.at, { card: { id: it.cardId, kind: it.cardKind ?? "tool", computer: it.computer ?? null, options: it.options ?? [], issuedAt: it.at } });
        if (it.state !== "pending") push("card_resolved", it.at, { id: it.cardId, outcome: it.state });
        break;
      case "note":
        push("note", it.at, { text: it.text, ...(it.from?.kind === "plugin" ? { from: { kind: "plugin", pluginId: it.from.id } } : {}) });
        break;
      case "agent-report":
        if (it.from.kind === "bot") push("bot_message", it.at, { from: it.from.id, text: it.text });
        else if (it.from.kind === "agent") push("agent_message", it.at, { agent: it.from.id, text: it.text });
        else push("plugin_message", it.at, { from: { pluginId: it.from.id }, text: it.text });
        break;
      case "task-notification":
        if (it.task.kind === "agent") push("agent_finished", it.at, { agent: it.task.agentId, ...(it.task.backend ? { backend: it.task.backend } : {}), stopReason: it.status === "stopped" ? "aborted" : it.status === "failed" ? "error" : it.status === "stalled" ? "stalled" : "end_turn", ...(it.report ? { text: it.report } : {}) });
        break;
      default:
        break;
    }
  }
  if (!running) {
    // A finished turn ends with the core's own word for it.
    if (out.length > 0) push("turn_completed", out[out.length - 1]!.ts as number, { stopReason: "end_turn" });
    return out;
  }
  // A turn still going started with the user's last message; what follows it is that turn's (a card it waits on
  // marks it waiting).
  const lastUser = out.map((e) => e.type).lastIndexOf("user_message");
  const at = (out[lastUser] ?? out[0])?.ts ?? NOW;
  out.splice(lastUser + 1, 0, { type: "turn_started", seq: 0, ts: at });
  return out.map((e, i) => ({ ...e, seq: i + 1 }));
}

// -------------------------------------------------------------------------------------------------
// A world
// -------------------------------------------------------------------------------------------------

export interface WorldOptions {
  /** Each session's transcript, and whether its turn is still going. */
  transcripts?: Record<string, { items: readonly ConversationItem[]; running?: boolean }>;
  /** Cards waiting now. */
  cards?: CardMeta[];
  /** Plugins beyond Clover's own: their entries and components. */
  extra?: { pluginId: string; entries: Omit<UiEntry, "pluginId" | "source" | "enabledAt">[]; components: Record<string, EntryComponent>; capabilities?: string[] }[];
}

type Handlers = { [M in keyof CoreMethods]?: (params: CoreMethods[M]["params"]) => CoreMethods[M]["result"] };

const coreHandlers: Handlers = {
  "account.status": () => ({ signedIn: true, provider: "email", user: { id: "u1", name: "Sam" } }),
  "plugin.list": () => ({ plugins: PLUGINS }),
  "plugin.get": ({ id }) => {
    const p = PLUGINS.find((x) => x.id === id);
    if (!p) throw new Error("not installed");
    return { plugin: pluginDetail(p, { provenance: { by: "user-app", at: NOW }, ...(CAPABILITIES[id] ?? {}) }) };
  },
  "plugin.setEnabled": () => ({ applied: true }),
  "plugin.logs": () => ({ lines: LOG_LINES }),
  "plugin.ui": () => ({
    plugins: [
      uiPluginView("clover/base-theme", [{ id: "base", file: "theme.css" }], []),
      uiPluginView("alpha", [{ id: "alpha-tab", file: "tab.css" }], [{ lang: "ja", file: "ja.json" }]),
      uiPluginView("midnight", [{ id: "midnight", file: "midnight.css" }], [{ lang: "de", file: "de.json" }, { lang: "fr", file: "fr.json" }]),
    ],
  }),
  "plugin.index.list": () => ({ indexes: INDEXES }),
  "plugin.index.search": ({ query }) => ({ entries: INDEX_ENTRIES.filter((e) => !query || `${e.id} ${e.name ?? ""} ${e.description ?? ""}`.toLowerCase().includes(query.toLowerCase())) }),
  "plugin.install": ({ source }) => ({ id: source.from === "index" ? source.id : "local", state: "found" }),
  "ui.settings": () => ({ picks: [], lists: [], language: "en-US", globalTheme: "clover/base-theme#base" }),
  "ui.set": () => ({ applied: true }),
  // A sensitive change comes back as a card the core raises (`raise` below adds it to the world's cards).
  "computer.setLevel": () => ({ applied: false, card: "card-level" }),
  "device.revoke": () => ({ applied: false, card: "card-device" }),
  "main.set": () => ({ applied: false, card: "card-main" }),
  "device.pair.begin": () => ({ pairingId: "pair-1", code: "KQ7-M2P", expiresAt: NOW + 600_000 }),
  "device.pair.join": () => ({ pairingId: "pair-2", words: ["amber", "river", "lantern", "moss"], expiresAt: NOW + 600_000 }),
  "device.pair.confirm": () => ({ applied: false, card: "card-pair" }),
  "device.pair.cancel": () => ({ ok: true }),
  "bot.setUserLayer": () => ({ applied: true }),
  "session.send": () => ({ seq: 1 }),
  "session.interrupt": () => ({ ok: true }),
  "session.stop": () => ({ ok: true }),
  "session.setModel": () => ({ ok: true }),
  "session.changes": ({ id }) => (SESSIONS.find((s) => s.id === id)?.kind === "coding" && SESSION_COLUMN.changes ? { label: SESSION_COLUMN.changes.label, added: SESSION_COLUMN.changes.added, removed: SESSION_COLUMN.changes.removed, files: SESSION_COLUMN.changes.files, prs: SESSION_COLUMN.changes.prs ?? [] } : null),
  "session.diff": () => ({ base: "main", target: "working tree", targets: ["last commit"], files: FILES, notice: "Large files start folded. Open one to see it whole." }),
  "session.createPr": () => ({ ok: true }),
  "session.outputs": ({ id }) =>
    id === "s_alpha"
      ? { items: [{ id: "b1", name: "This week in the clover repo", kind: "page" }, { id: "b2", name: "garden-beds.csv", kind: "file" }], more: 0 }
      : { items: SESSION_COLUMN.outputs?.items ?? [], more: SESSION_COLUMN.outputs?.more ?? 0 },
  "session.context": ({ id }) => (id === "s_alpha" ? { used: 0.31, tokens: 62_000, window: 200_000 } : { used: 0.14, tokens: 28_000, window: 200_000 }),
  "session.connectors": () => ({ total: 7, needSignIn: 2 }),
  "models.catalog": () => ({ models: MODELS.models.map((m) => ({ id: m.id, label: m.label, ...(m.detail ? { provider: m.detail } : {}), efforts: MODELS.efforts ?? [] })) as never }),
  "archive.list": ({ query, before }) => {
    const matching = ARCHIVED.filter((s) => !query || (s.title ?? "").toLowerCase().includes(query.toLowerCase()));
    return { sessions: before ? matching.filter((s) => s.updatedAt < before) : matching, more: false };
  },
  "archive.history": ({ id }) => ({ events: id === "w-1" ? ARCHIVE_HISTORY : [] }),
};

/** A world's runtime: the bundled parts plus any extra plugins, over the mock core and API. */
const TOKENS = {};

export function world(options: WorldOptions = {}): UiRuntime {
  const transcripts = options.transcripts ?? {};
  const events = (id: string) => {
    const t = transcripts[id];
    return t ? toEvents(t.items, t.running) : [];
  };
  let cards = options.cards ?? [];
  const listeners = new Set<() => void>();
  const raise = (id: string) => {
    if (cards.some((c) => c.id === id)) return;
    cards = [...cards, card(id, { issuedAt: NOW })];
    for (const l of listeners) l();
  };
  const sessions = SESSIONS.map((s) => (transcripts[s.id]?.running ? { ...s, status: "prompting" as const } : s));

  const core: CoreClient = {
    call(method, params) {
      const handler = coreHandlers[method] as ((p: unknown) => unknown) | undefined;
      if (!handler) return fail(`no such method: ${method}`);
      try {
        const result = handler(params) as { applied?: boolean; card?: string };
        if (result && result.applied === false && result.card) raise(result.card);
        return later(result) as never;
      } catch (e) {
        return fail(String(e));
      }
    },
    on: () => () => undefined,
  };

  const extra = options.extra ?? [];
  const plugins = [
    ...BUNDLED,
    ...extra.map((x) => ({ pluginId: x.pluginId, capabilities: x.capabilities ?? [], entries: x.entries.map((e) => ({ ...e, pluginId: x.pluginId, source: "installed" as const, enabledAt: 1 })), client: x.components as Record<string, unknown> })),
  ];

  const terminals = new Map<string, number>();
  // One API object per plugin for the world's life: the parts' effects depend on it, as they will on E's.
  const apis = new Map<string, PluginApi>();
  const api = (pluginId: string): PluginApi => {
    let made = apis.get(pluginId);
    if (!made) apis.set(pluginId, (made = makeApi(pluginId)));
    return made;
  };
  const makeApi = (pluginId: string): PluginApi => {
    const caps = new Set(plugins.find((p) => p.pluginId === pluginId)?.capabilities ?? []);
    const has = (c: string) => pluginId.startsWith("clover/") || caps.has(c);
    const points: Record<string, PointEntry[]> = {
      "avatar.packs": AVATARS.map((a) => ({ pluginId: a.id.split("#")[0]!, entryId: a.id.split("#")[1]!, value: { id: a.id.split("#")[1]!, name: a.name, file: a.file, format: a.format, ...(a.portraitUrl ? { portrait: a.portraitUrl } : {}) } })),
    };
    const base = fakeApi({ pluginId, computer: "Studio" });
    return {
      ...base,
      settings: { get: () => later(undefined), set: () => later(undefined), watch: () => () => undefined },
      points: { ...base.points, entries: <T,>(point: string) => later((points[point] ?? []) as PointEntry<T>[]) },
      ...(has("bots.read") ? { bots: { list: () => later(BOTS), get: (id: string) => (BOTS.find((b) => b.id === id) ? later(BOTS.find((b) => b.id === id)!) : fail("no bot")), watch: () => () => undefined } } : {}),
      ...(has("conversation.read")
        ? {
            conversation: {
              list: () => later(sessions),
              get: (id: string) => (sessions.find((s) => s.id === id) ? later(sessions.find((s) => s.id === id)!) : fail("no session")),
              history: (id: string) => later({ events: events(id), hasMore: false }),
              follow: () => () => undefined,
              answer: () => later(undefined),
            },
          }
        : {}),
      ...(has("computers.read") ? { computers: { list: () => later(COMPUTERS), watch: () => () => undefined } } : {}),
      ...(has("devices.read") ? { devices: { list: () => later(DEVICES), watch: () => () => undefined } } : {}),
      ...(has("approvals")
        ? {
            approvals: {
              pending: () => later(cards),
              watch: (fn: (c: CardMeta[]) => void) => {
                const l = () => fn(cards);
                listeners.add(l);
                return () => void listeners.delete(l);
              },
            },
          }
        : {}),
      ...(has("files")
        ? {
            files: {
              list: (path: string) => later((LISTING[path] ?? []).map((e) => ({ path: e.path, type: e.type, size: 1, modifiedAt: NOW, executable: false }))),
              readText: (path: string) => later(path === OPEN_FILE.path ? OPEN_FILE.text : ""),
              grep: () => later({ matches: [], truncated: false }),
              stat: () => later(null),
              readBytes: () => fail("the gallery reads text only"),
              write: () => fail("the gallery's folder is read only"),
              remove: () => fail("the gallery's folder is read only"),
              move: () => fail("the gallery's folder is read only"),
              glob: () => later({ paths: [], truncated: false }),
            },
          }
        : {}),
      ...(has("terminal")
        ? {
            terminal: {
              open: () => {
                const id = `t${terminals.size + 1}`;
                terminals.set(id, 0);
                return later({ terminalId: id });
              },
              input: () => later(undefined),
              onData: (_id: string, fn: (data: string) => void) => {
                // The PTY's first output: the feed the terminal's own stories show.
                void later(undefined).then(() => fn(FEED.map((c) => c.text).join("")));
                return () => undefined;
              },
              resize: () => later(undefined),
              close: () => later(undefined),
            },
          }
        : {}),
    };
  };

  const sealed = mockSealed({ cards: SEALED_CARDS });
  const approvals = {
    cards: () => cards,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };

  return runtimeWith({
    spot: (name) => SPOT_DECLS[name],
    entries: plugins.flatMap((p) => p.entries),
    component: (pluginId, name) => plugins.find((p) => p.pluginId === pluginId)?.client[name] as EntryComponent | undefined,
    uiSettings: () => ({ picks: [], lists: [] }),
    sessionKind: (id) => sessions.find((s) => s.id === id)?.kind,
    api,
    core: () => core,
    tokens: () => TOKENS,
    approvals,
    sealed,
    os: "macos",
  });
}

/** A card waiting in a session, as plugins hear of it. */
export const waitingCard = (id: string, session?: string): CardMeta =>
  card(id, { kind: "tool", issuedAt: NOW, ...(session ? { session } : {}), options: [{ id: "allow_once", kind: "approve" }, { id: "allow_always", kind: "approve", remember: "always" }, { id: "deny", kind: "deny" }] });
