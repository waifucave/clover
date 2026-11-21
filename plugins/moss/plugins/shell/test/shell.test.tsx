// The default shell on the runtime: routes, the panels each tab offers (the owner's item 90), the dialog layer and its
// card rule, the tab it ships and its page that starts a session. MOSS Code's window has no bots (spec §9.4, G8): a
// kept route that names a bot is dropped. The other parts stand in as stubs that show the props their spots got.
import { type TestEntry as UiEntry, card, fakeApi, fakeApprovals, fakeCore, settle, runtimeWith, TestLayer } from "@waifucave/moss-plugin-sdk/ui/testing";
import type { SessionView } from "@waifucave/moss-plugin-sdk";
import type { EntryComponent } from "../client/local";
import { catalogSpot } from "@waifucave/moss-plugin-sdk/ui/testing";
import { Spot } from "@waifucave/moss-plugin-sdk/ui";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentTab } from "../client/Tabs";
import { keptRouteOf, newestCoding, Shell, startRoute, type ShellStart } from "../client/Shell";
import { agentsHere } from "../client/NewSession";

afterEach(cleanup);
// What a part keeps across a reload is the window's session storage: each test starts with none.
afterEach(() => sessionStorage.clear());

const s = (id: string, extra: Partial<SessionView>): SessionView => ({ id, kind: "agent", computer: "Studio", status: "idle", startedAt: 0, updatedAt: 0, ...extra });
const SESSIONS = [
  s("agent-1", { parent: "s_alpha", bot: "alpha", backend: "Codex", title: "Fix the dates", status: "prompting" }),
  s("code-1", { kind: "coding", root: "home/Studio/projects/moss", title: "The panels", backend: "Codex", startedAt: 5 }),
  s("code-0", { kind: "coding", root: "home/Studio/projects/old", title: "Older", backend: "moss-code", startedAt: 1 }),
];

/** A stub that shows which spot it fills and the props it got (functions by name). */
const stub = (label: string): EntryComponent => ({ props }) => (
  <div data-stub={label}>{`${label} ${JSON.stringify(props, (k, v) => (typeof v === "function" ? `fn:${k}` : k === "header" ? undefined : v))}`}</div>
);
const SidebarStub: EntryComponent = ({ props }) => (
  <nav data-stub="sidebar">
    {JSON.stringify(props.route)}
    <button type="button" onClick={() => (props.navigate as (r: unknown) => void)({ route: "agent", params: { session: "code-1" } })}>
      go code
    </button>
    <button type="button" onClick={() => (props.navigate as (r: unknown) => void)({ route: "settings", params: {} })}>
      go settings
    </button>
    <button type="button" onClick={() => (props.navigate as (r: unknown) => void)({ route: "bot", params: { bot: "alpha" } })}>
      go alpha
    </button>
    <button type="button" onClick={() => (props.navigate as (r: unknown) => void)({ route: "plugins", params: {} })}>
      go plugins
    </button>
  </nav>
);

const COMPONENTS: Record<string, EntryComponent> = {
  Shell: Shell as EntryComponent,
  AgentTab: AgentTab as EntryComponent,
  Sidebar: SidebarStub,
  Conversation: stub("conversation"),
  Composer: stub("composer"),
  Column: stub("panel:session"),
  Terminal: stub("panel:terminal"),
  Settings: stub("main:settings"),
  Browser: stub("panel:browser"),
  Dead: () => <iframe data-moss-entry="juniper#browser" />,
  Status: stub("status"),
  Sheets: stub("panel:sheets"),
  Notes: stub("panel:notes"),
};

const entry = (pluginId: string, spot: string, component: string, extra: Partial<UiEntry> = {}): UiEntry => ({ pluginId, id: extra.id ?? `${spot}${extra.key ? `:${extra.key}` : ""}`, spot, component, source: "bundled", enabledAt: 0, ...extra });

const ENTRIES: UiEntry[] = [
  entry("moss/shell", "app.root", "Shell"),
  entry("moss/shell", "main", "AgentTab", { key: "agent" }),
  entry("moss/shell", "panel", "AgentTab", { key: "agent", when: { session: "agent" } }),
  entry("moss/sidebar", "sidebar", "Sidebar"),
  entry("moss/conversation", "conversation", "Conversation"),
  entry("moss/composer", "composer", "Composer"),
  entry("moss/panel", "panel", "Column", { key: "session", when: { session: ["coding", "agent"] } }),
  entry("moss/panel-terminal", "panel", "Terminal", { key: "terminal", when: { session: "coding" } }),
  entry("moss/settings", "main", "Settings", { key: "settings" }),
];

async function mount(start?: ShellStart, extra: UiEntry[] = [], sessions: SessionView[] = SESSIONS, onWatch?: (listener: (v: SessionView) => void) => void, shellProps: Record<string, unknown> = {}, handlers: Record<string, (params: any) => unknown> = {}) {
  const core = fakeCore({ "session.interrupt": () => ({ ok: true }), "session.stop": () => ({ ok: true }), ...handlers });
  const approvals = fakeApprovals();
  const api = fakeApi({
    sessions: { list: async () => sessions, get: async (id) => sessions.find((x) => x.id === id)!, watch: (l) => { onWatch?.(l); return () => undefined; }, history: async () => ({ events: [], hasMore: false }), follow: () => () => undefined },
  });
  const runtime = runtimeWith({
    spot: catalogSpot,
    entries: [...ENTRIES, ...extra],
    component: (_p, name) => COMPONENTS[name],
    api: () => api,
    core: () => core,
    approvals,
    sessionKind: (id) => sessions.find((x) => x.id === id)?.kind,
  });
  const tree = (extraProps: Record<string, unknown>) => (
    <TestLayer runtime={runtime}>
      <Spot name="app.root" props={start ? { start, ...extraProps } : extraProps} />
    </TestLayer>
  );
  const rendered = render(tree(shellProps));
  await act(() => settle(20));
  /** The window's `act` prop arriving after it has drawn (what a plugin frame's `shell.openPanel` becomes). */
  const send = async (extraProps: Record<string, unknown>) => { rendered.rerender(tree(extraProps)); await act(() => settle(20)); };
  return { core, approvals, send };
}

const toggles = () => [...document.querySelectorAll(".cl-panel-toggles .cl-panel-toggle")].map((b) => b.getAttribute("aria-label"));
const stubText = (label: string) => document.querySelector(`[data-stub="${label}"]`)?.textContent ?? null;

describe("the shell's session list", () => {
  test("a coding session started outside the window is known without a tab change: its tab gets the coding panels", async () => {
    let emit: ((v: SessionView) => void) | undefined;
    await mount({ route: { route: "agent", params: { session: "code-new" } } }, [], SESSIONS, (l) => (emit = l));
    expect(toggles()).not.toContain("Terminal");
    await act(async () => emit!(s("code-new", { kind: "coding", root: "home/Studio/projects/cli", title: "From the CLI", startedAt: 5 })));
    await act(() => settle(20));
    expect(toggles()).toContain("Terminal");
  });

  test("the Code side goes to the newest coding session", () => {
    const list = [s("code-a", { kind: "coding", startedAt: 1 }), s("code-c", { kind: "coding", startedAt: 9 }), s("code-b", { kind: "coding", startedAt: 4 }), s("agent-x", { kind: "agent", startedAt: 20 })];
    expect(newestCoding(list)?.id).toBe("code-c");
    expect(newestCoding([s("agent-x", { kind: "agent" })])).toBeUndefined();
    // A live one is preferred over a newer one that stopped; an archived one is never where the Code side goes.
    expect(newestCoding([...list, s("code-d", { kind: "coding", startedAt: 20, status: "stopped" }), s("code-e", { kind: "coding", startedAt: 30, archived: true })])?.id).toBe("code-c");
    // With none live, the newest that stopped.
    const ended = [s("code-d", { kind: "coding", startedAt: 20, status: "stopped" }), s("code-f", { kind: "coding", startedAt: 5, status: "stopped" }), s("code-e", { kind: "coding", startedAt: 30, archived: true })];
    expect(newestCoding(ended)?.id).toBe("code-d");
    expect(newestCoding([s("code-e", { kind: "coding", archived: true })])).toBeUndefined();
  });
});

describe("where the window starts, with no bots in it", () => {
  test("a first start opens the newest code session's tab; with none, the page that starts one", async () => {
    expect(startRoute(undefined)).toBeUndefined();
    expect(startRoute(SESSIONS)).toEqual({ route: "agent", params: { session: "code-1" } });
    expect(startRoute([])).toEqual({ route: "new", params: {} });
    await mount();
    expect(stubText("conversation")).toContain('"session":"code-1"');
    cleanup();
    await mount(undefined, [], []);
    expect(document.querySelector(".cl-new-session")).not.toBeNull();
  });

  test("a route the window kept from before (a bot's tab, its editor) is dropped: the window starts as on a first start, and doesn't break", async () => {
    expect(keptRouteOf({ route: "bot", params: { bot: "alpha" } })).toBeUndefined();
    expect(keptRouteOf({ route: "bot-editor", params: { bot: "alpha" } })).toBeUndefined();
    expect(keptRouteOf({ route: "settings", params: {} })).toEqual({ route: "settings", params: {} });
    expect(keptRouteOf({ route: "agent", params: { session: "code-0" } })).toEqual({ route: "agent", params: { session: "code-0" } });
    // An old window's session storage: Alpha's tab shown, Settings over it, her panels open.
    sessionStorage.setItem("moss.kept:moss/shell:shell.route", JSON.stringify({ route: "bot", params: { bot: "alpha" } }));
    sessionStorage.setItem("moss.kept:moss/shell:shell.under", JSON.stringify({ route: "bot", params: { bot: "alpha" } }));
    sessionStorage.setItem("moss.kept:moss/shell:shell.panels", JSON.stringify({ "bot:alpha": ["session", "browser"] }));
    await mount();
    expect(stubText("conversation")).toContain('"session":"code-1"');
    expect(document.querySelector(".cl-window__dialog")).toBeNull();
    expect(JSON.parse(sessionStorage.getItem("moss.kept:moss/shell:shell.under")!)).toBeNull();
    // A press that would go to a bot goes nowhere.
    fireEvent.click(screen.getByRole("button", { name: "go alpha" }));
    await act(() => settle(20));
    expect(stubText("conversation")).toContain('"session":"code-1"');
  });

  test("an act that names a bot (a plugin's `shell.go`) has no place here; the Code side goes to the newest session", async () => {
    const opened = await mount({ route: { route: "plugins", params: {} } });
    await opened.send({ act: { n: 1, act: { kind: "go", target: { bot: "alpha" } } } });
    expect(stubText("sidebar")).toContain('"route":"plugins"');
    await opened.send({ act: { n: 2, act: { kind: "go", target: { side: "code" } } } });
    expect(stubText("conversation")).toContain('"session":"code-1"');
  });
});

describe("the page that starts a session (spec §9.4)", () => {
  test("the agents installed here, MOSS's own first; a folder from the app's own dialog; Start starts it and shows its tab", async () => {
    const backends = [
      { id: "codex", name: "Codex", computers: [{ computer: "Studio", installed: true }] },
      { id: "gemini", name: "Gemini", computers: [{ computer: "Studio", installed: false }] },
      { id: "moss-code", name: "MOSS", computers: [{ computer: "Studio", installed: true }] },
      { id: "moss", name: "MOSS subagent", userStartable: false, computers: [{ computer: "Studio", installed: true }] },
    ];
    expect(agentsHere(backends, "Studio")).toEqual([
      { id: "moss-code", name: "MOSS", installed: true }, { id: "codex", name: "Codex", installed: true }, { id: "gemini", name: "Gemini", installed: false },
    ]);
    const started = s("code-new", { kind: "coding", title: "New", startedAt: 9 });
    const sessions = [...SESSIONS];
    const { core } = await mount({ route: { route: "new", params: {} } }, [], sessions, undefined, {}, {
      "agent.backends": () => ({ backends }),
      "computer.list": () => ({ computers: [{ name: "Studio", link: "self" }] }),
      "ui.pick": () => ({ token: "pick-1", name: "projects" }),
      "agent.start": () => { sessions.push(started); return { session: "code-new" }; },
    });
    const radios = [...document.querySelectorAll<HTMLInputElement>(".cl-new-session__agent input")];
    expect(radios.map((r) => [r.value, r.checked, r.disabled])).toEqual([["moss-code", true, false], ["codex", false, false], ["gemini", false, true]]);
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Choose a folder…" }));
    await act(() => settle(20));
    expect(document.querySelector(".cl-new-session__folder-name")?.textContent).toBe("projects");
    fireEvent.click(radios[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await act(() => settle(20));
    expect(core.calls.find((c) => c.method === "ui.pick")?.params).toEqual({ kind: "folder", use: "agent.start" });
    expect(core.calls.find((c) => c.method === "agent.start")?.params).toEqual({ backend: "codex", root: "pick-1" });
    expect(stubText("sidebar")).toContain('{"route":"agent","params":{"session":"code-new"}}');
  });

  test("a session's tab names its agent by the backend's display name, not its id, and falls back to the id for a backend with no name", async () => {
    await mount({ route: { route: "agent", params: { session: "code-0" } } }, [], SESSIONS, undefined, {}, {
      "agent.backends": () => ({ backends: [{ id: "moss-code", name: "MOSS's coding agent", computers: [] }] }),
    });
    await act(() => settle(20));
    expect(stubText("conversation")).toContain("MOSS's coding agent");
    expect(stubText("conversation")).not.toContain('"name":"moss-code"');
    expect(stubText("composer")).toContain('"name":"MOSS\'s coding agent"');
    cleanup();
    await mount({ route: { route: "agent", params: { session: "code-1" } } }, [], SESSIONS, undefined, {}, {
      "agent.backends": () => ({ backends: [{ id: "moss-code", name: "MOSS's coding agent", computers: [] }] }),
    });
    await act(() => settle(20));
    expect(stubText("conversation")).toContain('"name":"Codex"');
  });

  test("a refusal (no folder of this computer's home, say) shows its reason and starts nothing", async () => {
    await mount({ route: { route: "new", params: {} } }, [], SESSIONS, undefined, {}, {
      "agent.backends": () => ({ backends: [{ id: "moss-code", name: "MOSS", computers: [{ computer: "Studio", installed: true }] }] }),
      "computer.list": () => ({ computers: [{ name: "Studio", link: "self" }] }),
      "ui.pick": () => ({ token: "pick-1", name: "elsewhere" }),
      "agent.start": () => { throw new Error("a session works in a folder of this computer's home"); },
    });
    fireEvent.click(screen.getByRole("button", { name: "Choose a folder…" }));
    await act(() => settle(20));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await act(() => settle(20));
    expect(screen.getByRole("alert").textContent).toContain("a folder of this computer's home");
    expect(stubText("sidebar")).toContain('"route":"new"');
  });
});

describe("panels plugins add (§5.5): a `panel` entry whose key isn't a stock panel's", () => {
  const added = (pluginId: string, key: string, title: string, extra: Partial<UiEntry> = {}) => entry(pluginId, "panel", "Sheets", { key, id: `panel-${key}`, source: "installed", fields: { title }, ...extra });
  const views = () => [...document.querySelectorAll(".cl-panel__view")].map((v) => v.getAttribute("data-view"));
  const press = (name: string) => fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}$`) }));

  test("its button follows the stock ones on the tabs of the kinds it names, and is not on the others", async () => {
    const sheets = added("sheets", "sheets", "Sheets", { when: { session: ["coding"] } });
    await mount({ route: { route: "agent", params: { session: "code-1" } } }, [sheets]);
    expect(toggles()).toEqual(["Session", "Terminal", "Sheets"]);
    cleanup();
    // An agent's tab (a bot's coding task): not a coding session's panel.
    await mount({ route: { route: "agent", params: { session: "agent-1" } } }, [sheets]);
    expect(document.querySelector('[data-own-panel="sheets#sheets"]')).toBeNull();
    cleanup();
    // No `when.session`: every tab.
    await mount({ route: { route: "agent", params: { session: "agent-1" } } }, [added("docs", "docs", "Documents")]);
    expect(document.querySelector('[data-own-panel="docs#docs"]')).not.toBeNull();
  });

  test("it opens beside a stock panel and draws; a third view pushes the oldest out (at most two)", async () => {
    await mount({ route: { route: "agent", params: { session: "code-1" } }, panels: ["terminal"] }, [added("sheets", "sheets", "Sheets")]);
    expect(views()).toEqual(["terminal"]);
    press("Sheets");
    await act(() => settle(20));
    expect(views()).toEqual(["terminal", "sheets#sheets"]);
    expect(stubText("panel:sheets")).toContain('"app":"sheets"');
    expect(screen.getByRole("button", { name: "Sheets" }).getAttribute("aria-pressed")).toBe("true");
    press("Session");
    press("Terminal");
    await act(() => settle(20));
    expect(views()).toEqual(["sheets#sheets"]);
  });


  test("two plugins' panels with one key are two panels: the ids are namespaced by plugin", async () => {
    await mount({ route: { route: "agent", params: { session: "code-1" } }, panels: ["terminal"] }, [added("one", "notes", "One notes"), added("two", "notes", "Two notes")]);
    expect(toggles()).toEqual(["Session", "Terminal", "One notes", "Two notes"]);
    press("Two notes");
    await act(() => settle(20));
    expect(views()).toEqual(["terminal", "two#notes"]);
    press("One notes");
    await act(() => settle(20));
    expect(views()).toEqual(["two#notes", "one#notes"]);
  });


  test("past three, the rest are in one menu button, never an overflowing bar", async () => {
    const five = ["a", "b", "c", "d", "e"].map((k) => added(`p-${k}`, k, `Panel ${k.toUpperCase()}`, { order: 500 + k.charCodeAt(0) }));
    await mount({ route: { route: "agent", params: { session: "code-1" } } }, five);
    expect(toggles()).toEqual(["Session", "Terminal", "Panel A", "Panel B", "Panel C", "Other panels"]);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Other panels" }));
    const items = [...document.querySelectorAll('[role="menuitemcheckbox"]')].map((i) => i.textContent);
    expect(items).toEqual(["Panel D", "Panel E"]);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Panel E" }));
    await act(() => settle(20));
    expect(views()).toEqual(["p-e#e"]);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Other panels" }).getAttribute("aria-pressed")).toBe("true");
  });


  test("a panel whose part draws nothing shows the host's placeholder", async () => {
    await mount({ route: { route: "agent", params: { session: "code-1" } }, panels: ["terminal"] }, [added("sheets", "sheets", "Sheets", { component: "Missing" })]);
    press("Sheets");
    await act(() => settle(20));
    expect(document.querySelector('[data-empty-view="sheets#sheets"]')).not.toBeNull();
  });

});

describe("the shell", () => {
  test("a session's tab: its conversation over its composer, the coding panels", async () => {
    await mount({ route: { route: "agent", params: { session: "code-1" } } });
    expect(stubText("conversation")).toContain('"session":"code-1"');
    expect(stubText("composer")).toContain('"session":"code-1"');
    expect(toggles()).toEqual(["Session", "Terminal"]);
    expect(document.querySelector(".cl-bot-tab__stage")).toBeNull();
    expect(document.querySelector(".cl-bot-header")).toBeNull();
  });

  test("where the user is outlives a reload of the window's document: the route, and Settings over the tab under it", async () => {
    await mount(undefined, []);
    fireEvent.click(screen.getByRole("button", { name: "go code" }));
    await act(() => settle(20));
    fireEvent.click(screen.getByRole("button", { name: "go settings" }));
    await act(() => settle(20));
    expect(document.querySelector(".cl-window__dialog [data-stub='main:settings']")).toBeTruthy();
    expect(stubText("sidebar")).toContain('{"route":"agent","params":{"session":"code-1"}}');
    // The document goes with no unmount (a reload runs no cleanup): the window's session storage as it was.
    const atReload = new Map(Array.from({ length: sessionStorage.length }, (_, i) => [sessionStorage.key(i)!, sessionStorage.getItem(sessionStorage.key(i)!)!] as const));
    cleanup();
    expect(sessionStorage.length).toBe(0);
    for (const [k, v] of atReload) sessionStorage.setItem(k, v);
    await mount(undefined, []);
    // The same place from the first render: Settings, with the session's tab under it.
    expect(document.querySelector(".cl-window__dialog [data-stub='main:settings']")).toBeTruthy();
    expect(stubText("sidebar")).toContain('{"route":"agent","params":{"session":"code-1"}}');
    expect(stubText("conversation")).toContain('"session":"code-1"');
    expect(JSON.parse(atReload.get("moss.kept:moss/shell:shell.under")!)).toEqual({ route: "agent", params: { session: "code-1" } });
  });


  test("a toggle is offered only for a panel something fills; an open panel whose filler is gone closes, not a placeholder", async () => {
    // Session and terminal are filled; the changes, the browser and the files are not.
    await mount({ route: { route: "agent", params: { session: "code-1" } }, panels: ["session", "terminal", "browser"] });
    expect(toggles()).toEqual(["Session", "Terminal"]);
    expect(stubText("panel:session")).toContain('"sessionKind":"coding"');
    expect(stubText("panel:terminal")).toContain('"app":"terminal","session":"code-1"');
    // The browser was open with no plugin behind it: closed, no placeholder.
    expect(document.querySelector('[data-empty-view="browser"]')).toBeNull();
    cleanup();
    // With a plugin behind it the toggle is there, and the panel stays.
    await mount({ route: { route: "agent", params: { session: "code-1" } }, panels: ["session", "browser"] }, [entry("moss/browser-view", "panel", "Browser", { key: "browser" })]);
    expect(toggles()).toEqual(["Session", "Terminal", "Browser"]);
    expect(stubText("panel:browser")).toContain('"app":"browser"');
  });


  test("the agent tab has no interrupt or stop button until the host callbacks cover them (no bare core call)", async () => {
    const { core } = await mount({ route: { route: "agent", params: { session: "agent-1" } } });
    expect(screen.queryByRole("button", { name: "Interrupt" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(core.calls.some((c) => c.method === "session.interrupt" || c.method === "session.stop")).toBe(false);
    expect(toggles()).toEqual(["Session"]);
  });


  test("Settings opens as a dialog over the tab; a card with no session (one Settings raised) closes it", async () => {
    const { approvals } = await mount({ route: { route: "agent", params: { session: "code-1" } } });
    fireEvent.click(screen.getByRole("button", { name: "go settings" }));
    await act(() => settle());
    expect(document.querySelector(".cl-window__dialog [data-stub='main:settings']")).toBeTruthy();
    expect(stubText("conversation")).toContain('"session":"code-1"');
    act(() => approvals.set([card("card-level")]));
    await act(() => settle());
    expect(document.querySelector(".cl-window__dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Answer the waiting card first, then open it again.");
  });


  test("a card in a session this window doesn't show holds nothing", async () => {
    const { approvals } = await mount({ route: { route: "settings", params: {} }, under: { route: "agent", params: { session: "code-1" } } });
    act(() => approvals.set([card("c-other", { session: "code-0" })]));
    await act(() => settle());
    expect(document.querySelector(".cl-window__dialog [data-stub='main:settings']")).toBeTruthy();
  });


  test("a route no plugin fills says so; the status bar shows only when a plugin fills it", async () => {
    await mount({ route: { route: "usage", params: {} } });
    expect(screen.getByText("Nothing here yet")).toBeTruthy();
    expect(document.querySelector(".cl-window__status")).toBeNull();
    cleanup();
    await mount(undefined, [entry("moss-usage", "status", "Status")]);
    expect(document.querySelector(".cl-window__status [data-stub='status']")).toBeTruthy();
  });

  test("an app's title bar says its name from the route's `title` (the shell does not list the sidebar's apps itself), the key when none", async () => {
    await mount({ route: { route: "reel", params: { title: "Reel" } } });
    expect(document.querySelector(".cl-window__title-text")?.textContent).toBe("Reel");
    cleanup();
    await mount({ route: { route: "reel", params: {} } });
    expect(document.querySelector(".cl-window__title-text")?.textContent).toBe("reel");
  });
});
