// `PluginApi.shell` in the main process (spec §5.4's `shell.read` and `shell.control`): what a plugin's frame asks of the window itself, checked here
// and nowhere else. Pure, so every rule is unit-tested.
//
//   * the call must be one of the catalogued `shell.*` methods, and the plugin must hold its capability (`apiCallAllowed`, the one table the host uses);
//   * a plugin reaches the window only while one of its own bots shows its tab (a bot's id begins with its plugin's id), so a plugin that draws a bot's
//     bar or sidebar changes nothing while another bot's tab shows, and reads nothing of where the user is the rest of the time;
//   * an act counts only inside the user's own key press or click in the calling frame, one call per gesture (the Plugins page's rule); `dragWindow`
//     is the user's press on a region the main process itself saw, so it takes no gesture here (the drag's own rules in window-drag.ts apply);
//   * an act is data the shell applies to its own state: a place to show, a panel view, the sidebar's fold; never a conversation, a card or a file.
import { apiCallAllowed, type ShellAccount, type ShellApp, type ShellState } from "@waifucave/clover-plugin-sdk";
import { SHELL_ACTS, SHELL_READS, type ShellAct, type ShellMethod } from "@waifucave/clover-plugin-sdk/ui/bridge";

export type ShellCall =
  | { kind: "answer"; value: unknown }
  | { kind: "act"; act: ShellAct }
  | { kind: "drag" }
  | { kind: "provide"; parts: ("sidebar" | "drag")[] };

export interface ShellCallInput {
  method: unknown;
  args: unknown;
  plugin: { id: string; capabilities: ReadonlySet<string> | readonly string[] };
  /** What the shell last reported for this window. */
  window: { state: ShellState; apps: readonly ShellApp[]; account?: ShellAccount } | undefined;
  /** The sidebar's app buttons, read by the main process itself (only the sidebar part may list `sidebar.app`). */
  appButtons?(): readonly ShellApp[];
  /** The user's own key press or click in the calling frame, spent. */
  takeGesture(): boolean;
}

const VIEW = /^[a-z][a-z0-9-]{0,31}$/;
const ID = /^[A-Za-z0-9._:/-]{1,128}$/;
const topOf = (id: string): string => id.split("/")[0] ?? id;

/** Whether the plugin owns the bot whose tab shows: a bot's id is its plugin's id, or begins with it and a slash. */
export function ownsShownBot(pluginId: string, state: ShellState | undefined): boolean {
  return state?.bot !== undefined && topOf(state.bot) === topOf(pluginId);
}

/** The essential handles the shown bot's own frames offer now (`shell.provide`), from what each frame last said (by
 *  `<plugin>:<process>:<routing>`): only frames of the shown bot's plugin that are still there count. A frame's word is
 *  kept while another page shows, so its tab, kept hidden and shown again (the shell's KeptTab), still has its handles
 *  without asking again; a frame that is gone (unloaded, asleep) is forgotten. */
export function providedNow(provides: Map<string, ReadonlySet<string>>, state: ShellState | undefined, alive: (key: string) => boolean): { sidebar: boolean; drag: boolean } {
  for (const key of [...provides.keys()]) if (!alive(key)) provides.delete(key);
  const shown = [...provides].filter(([key]) => ownsShownBot(key.split(":")[0]!, state)).map(([, parts]) => parts);
  return { sidebar: shown.some((p) => p.has("sidebar")), drag: shown.some((p) => p.has("drag")) };
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function target(v: unknown): Extract<ShellAct, { kind: "go" }>["target"] {
  const t = obj(v);
  const keys = Object.keys(t);
  if (keys.length !== 1) throw new Error("shell.go names one place");
  if (typeof t.bot === "string" && ID.test(t.bot)) return { bot: t.bot };
  if (typeof t.session === "string" && ID.test(t.session)) return { session: t.session };
  if (t.side === "bots" || t.side === "code") return { side: t.side };
  if (typeof t.app === "string" && ID.test(t.app)) return { app: t.app };
  if (t.page === "plugins" || t.page === "archive") return { page: t.page };
  throw new Error("shell.go: not a place the window shows");
}

export function routeShell(i: ShellCallInput): ShellCall {
  const method = i.method;
  const known = [...SHELL_READS, ...SHELL_ACTS] as readonly unknown[];
  if (typeof method !== "string" || !known.includes(method)) throw new Error("not a shell call");
  const caps = [...i.plugin.capabilities];
  if (!apiCallAllowed(`shell.${method}`, "ui", caps)) throw new Error(`shell.${method} needs a capability this plugin doesn't hold`);
  if (!ownsShownBot(i.plugin.id, i.window?.state)) throw new Error("the window answers only while one of this plugin's bots shows its tab");
  const win = i.window!;
  const m = method as ShellMethod;
  if (m === "state") return { kind: "answer", value: win.state };
  if (m === "apps") return { kind: "answer", value: i.appButtons?.() ?? win.apps };
  if (m === "account") return { kind: "answer", value: win.account ?? { name: "" } };
  if (m === "dragWindow") return { kind: "drag" };
  if (m === "provide") {
    const parts = Array.isArray(obj(i.args).parts) ? (obj(i.args).parts as unknown[]) : [];
    return { kind: "provide", parts: (["sidebar", "drag"] as const).filter((p) => parts.includes(p)) };
  }
  if (!i.takeGesture()) throw new Error("a shell call counts only inside the user's own key press or click");
  const a = obj(i.args);
  const view = (): string => {
    if (typeof a.view !== "string" || !VIEW.test(a.view)) throw new Error("a panel view's name");
    return a.view;
  };
  switch (m) {
    case "openBotEditor": return { kind: "act", act: { kind: "editor", ...(typeof a.bot === "string" && ID.test(a.bot) ? { bot: a.bot } : {}) } };
    case "openPanel": return { kind: "act", act: { kind: "panel", view: view(), to: "open" } };
    case "closePanel": return { kind: "act", act: { kind: "panel", view: view(), to: "closed" } };
    case "togglePanel": return { kind: "act", act: { kind: "panel", view: view() } };
    case "setSidebar": return { kind: "act", act: { kind: "sidebar", collapsed: a.collapsed === true } };
    case "toggleSidebar": return { kind: "act", act: { kind: "sidebar" } };
    case "go": return { kind: "act", act: { kind: "go", target: target(a.target) } };
    case "openSettings": return { kind: "act", act: { kind: "settings", ...(typeof a.section === "string" && VIEW.test(a.section) ? { section: a.section } : {}) } };
  }
  throw new Error("not a shell call");
}

/** Whether a plugin's frames hear the window's state: it holds `shell.read` and one of its bots shows its tab. */
export function hearsShell(plugin: { id: string; capabilities: ReadonlySet<string> | readonly string[] }, state: ShellState | undefined): boolean {
  return ownsShownBot(plugin.id, state) && apiCallAllowed("shell.state", "ui", [...plugin.capabilities]);
}

/** A report from the shell, kept only as the data it must be: a tab, a bot id, the sidebar's fold, the panels' names, the safe area, the app buttons. */
export function cleanReport(v: unknown): { state: ShellState; apps: ShellApp[]; account?: ShellAccount } | undefined {
  const r = obj(v);
  const s = obj(r.state);
  const tab = obj(s.tab);
  const kinds = ["bot", "agent", "settings", "plugins", "app", "archive", "bot-editor", "other"] as const;
  const kind = kinds.find((k) => k === tab.kind);
  if (kind === undefined) return undefined;
  const sidebar = obj(s.sidebar);
  const panels = obj(s.panels);
  const safe = obj(s.safeArea);
  const acc = obj(r.account);
  const names = (x: unknown): string[] => (Array.isArray(x) ? x.filter((n): n is string => typeof n === "string" && VIEW.test(n)).slice(0, 16) : []);
  const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 400 ? x : 0);
  const apps = (Array.isArray(r.apps) ? r.apps : []).slice(0, 32).flatMap((x): ShellApp[] => {
    const o = obj(x);
    return typeof o.id === "string" && ID.test(o.id) && typeof o.title === "string" && o.title.length <= 64 ? [{ id: o.id, title: o.title, ...(typeof o.icon === "string" && o.icon.length <= 512 ? { icon: o.icon } : {}) }] : [];
  });
  return {
    state: {
      tab: { kind, ...(typeof tab.id === "string" && ID.test(tab.id) ? { id: tab.id } : {}) },
      ...(typeof s.bot === "string" && ID.test(s.bot) ? { bot: s.bot } : {}),
      sidebar: { collapsed: sidebar.collapsed === true, side: sidebar.side === "code" ? "code" : "bots" },
      panels: { open: names(panels.open), available: names(panels.available) },
      safeArea: { left: num(safe.left), top: num(safe.top) },
    },
    apps,
    ...(typeof acc.name === "string" && acc.name.length <= 128 ? { account: { name: acc.name, ...(typeof acc.detail === "string" && acc.detail.length <= 128 ? { detail: acc.detail } : {}) } } : {}),
  };
}
