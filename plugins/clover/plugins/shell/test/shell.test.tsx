// The default shell on the runtime: routes, the panels each tab offers (the owner's item 90), the dialog layer and its
// card rule, and the tabs it ships. The other parts stand in as stubs that show the props their spots got.
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { UiEntry } from "../runtime/resolve";
import { card, fakeApi, fakeApprovals, fakeCore, settle } from "../runtime/testkit";
import type { BotView, EntryComponent, SessionView } from "../runtime/types";
import { runtimeWith } from "../runtime/ui";
import { SPOT_DECLS } from "../runtime/catalog";
import { AgentTab, DefaultBotTab } from "../client/Tabs";
import { Shell, type ShellStart } from "../client/Shell";
import { Spot, UiRuntimeProvider } from "../client/sdk";

afterEach(cleanup);

const bot = (id: string, name: string): BotView => ({ id, name, model: "m", userLayer: [], state: "idle", mainSession: `s_${id}` });
const s = (id: string, extra: Partial<SessionView>): SessionView => ({ id, kind: "agent", computer: "Studio", status: "idle", startedAt: 0, updatedAt: 0, ...extra });
const BOTS = [bot("alpha", "Alpha"), bot("luna", "Luna")];
const SESSIONS = [
  s("s_alpha", { kind: "bot", bot: "alpha" }),
  s("s_luna", { kind: "bot", bot: "luna" }),
  s("agent-1", { parent: "s_alpha", bot: "alpha", backend: "Codex", title: "Fix the dates", status: "prompting" }),
  s("code-1", { kind: "coding", root: "home/Studio/projects/clover", title: "The panels", backend: "Codex" }),
];

/** A stub that shows which spot it fills and the props it got (functions by name). */
const stub = (label: string): EntryComponent => ({ props }) => (
  <div data-stub={label}>{`${label} ${JSON.stringify(props, (k, v) => (typeof v === "function" ? `fn:${k}` : k === "header" ? undefined : v))}`}</div>
);
const SideStub: EntryComponent = ({ props }) => (
  <div data-stub="bot.side">
    <button type="button" onClick={() => (props.onOpenAgent as (id: string) => void)("agent-1")}>
      open agent
    </button>
  </div>
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
  </nav>
);

const COMPONENTS: Record<string, EntryComponent> = {
  Shell: Shell as EntryComponent,
  DefaultBotTab: DefaultBotTab as EntryComponent,
  AgentTab: AgentTab as EntryComponent,
  Sidebar: SidebarStub,
  Conversation: stub("conversation"),
  Composer: stub("composer"),
  Side: SideStub,
  Column: stub("panel:session"),
  Terminal: stub("panel:terminal"),
  Settings: stub("main:settings"),
  Browser: stub("panel:browser"),
  Status: stub("status"),
};

const entry = (pluginId: string, spot: string, component: string, extra: Partial<UiEntry> = {}): UiEntry => ({ pluginId, id: extra.id ?? `${spot}${extra.key ? `:${extra.key}` : ""}`, spot, component, source: "bundled", enabledAt: 0, ...extra });

const ENTRIES: UiEntry[] = [
  entry("clover/shell", "app.root", "Shell"),
  entry("clover/shell", "bot.tab", "DefaultBotTab"),
  entry("clover/shell", "main", "AgentTab", { key: "agent" }),
  entry("clover/shell", "panel", "AgentTab", { key: "agent", when: { session: "agent" } }),
  entry("clover/sidebar", "sidebar", "Sidebar"),
  entry("clover/conversation", "conversation", "Conversation"),
  entry("clover/composer", "composer", "Composer"),
  entry("clover/panel", "bot.side", "Side"),
  entry("clover/panel", "panel", "Column", { key: "session", when: { session: ["coding", "agent"] } }),
  entry("clover/panel-terminal", "panel", "Terminal", { key: "terminal", when: { session: "coding" } }),
  entry("clover/settings", "main", "Settings", { key: "settings" }),
];

async function mount(start?: ShellStart, extra: UiEntry[] = []) {
  const core = fakeCore({ "session.interrupt": () => ({ ok: true }), "session.stop": () => ({ ok: true }) });
  const approvals = fakeApprovals();
  const api = fakeApi({
    bots: { list: async () => BOTS, get: async (id) => BOTS.find((b) => b.id === id)!, watch: () => () => undefined },
    conversation: { list: async () => SESSIONS, get: async (id) => SESSIONS.find((x) => x.id === id)! },
  });
  const runtime = runtimeWith({
    spot: (name) => SPOT_DECLS[name],
    entries: [...ENTRIES, ...extra],
    component: (_p, name) => COMPONENTS[name],
    api: () => api,
    core: () => core,
    approvals,
    sessionKind: (id) => SESSIONS.find((x) => x.id === id)?.kind,
  });
  render(
    <UiRuntimeProvider runtime={runtime}>
      <Spot name="app.root" props={start ? { start } : {}} />
    </UiRuntimeProvider>,
  );
  await act(() => settle(6));
  return { core, approvals };
}

const toggles = () => [...document.querySelectorAll(".cl-panel-toggles .cl-panel-toggle")].map((b) => b.getAttribute("aria-label"));
const stubText = (label: string) => document.querySelector(`[data-stub="${label}"]`)?.textContent ?? null;

describe("the shell", () => {
  test("opens on the first bot's tab: its conversation over its composer, the bot's toggles", async () => {
    await mount();
    expect(screen.getByRole("region", { name: "Alpha" })).toBeTruthy();
    expect(stubText("conversation")).toContain('"session":"s_alpha"');
    expect(stubText("composer")).toBe('composer {"bot":{"id":"alpha","name":"Alpha"},"session":"s_alpha"}');
    expect(toggles()).toEqual(["Details", "Browser"]);
    expect(screen.getByRole("button", { name: "Edit Alpha" })).toBeTruthy();
  });

  test("a bot's slim column opens its coding agent in the panel, as a live tab of its own (item 90)", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(screen.getByRole("button", { name: "open agent" }));
    await act(() => settle(6));
    const panel = screen.getByRole("region", { name: "Panel" });
    const agent = panel.querySelector('.cl-agent-tab[data-place="panel"]')!;
    expect(agent).toBeTruthy();
    expect(agent.textContent).toContain("Working");
    expect(agent.textContent).toContain("Codex on Studio");
    expect(within(agent as HTMLElement).getByText(/^conversation /).textContent).toContain('"session":"agent-1"');
    // No code panels and no column of its own in there.
    expect(panel.querySelector('[data-stub="panel:terminal"]')).toBeNull();
    expect(panel.querySelector('[data-stub="panel:session"]')).toBeNull();
  });

  test("a coding session's tab offers every panel; a panel no plugin fills shows the placeholder, which finds one", async () => {
    await mount({ route: { route: "agent", params: { session: "code-1" } }, panels: ["session", "terminal", "browser"] });
    expect(toggles()).toEqual(["Session", "Terminal", "Changes", "Browser", "Files"]);
    expect(stubText("panel:session")).toContain('"sessionKind":"coding"');
    expect(stubText("panel:terminal")).toContain('"app":"terminal","session":"code-1"');
    const browser = document.querySelector('[data-empty-view="browser"]')!;
    expect(browser.textContent).toContain("No plugin shows the browser here yet");
    fireEvent.click(within(browser as HTMLElement).getByRole("button", { name: "Find a plugin" }));
    expect(stubText("sidebar")).toContain('{"route":"plugins","params":{"spot":"panel","key":"browser"}}');
  });

  test("a panel view hears whose tab it is and whether the person used it last (R8), and draws its head in the host's row", async () => {
    await mount({ route: { route: "bot", params: { bot: "alpha" } }, panels: ["agent", "browser"], agent: "agent-1" }, [entry("clover/browser-view", "panel", "Browser", { key: "browser" })]);
    // The newest opened is the one used last, until the person uses the other.
    expect(stubText("panel:browser")).toContain('"bot":"alpha"');
    expect(stubText("panel:browser")).toContain('"usedLast":true');
    fireEvent.pointerDown(document.querySelector('.cl-panel__view[data-view="agent"]')!);
    expect(stubText("panel:browser")).toContain('"usedLast":false');
    expect(document.querySelector('.cl-panel__view[data-view="agent"]')!.hasAttribute("data-used-last")).toBe(true);
  });

  test("the agent tab interrupts and stops through the core", async () => {
    const { core } = await mount({ route: { route: "agent", params: { session: "agent-1" } } });
    fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(core.calls.map((c) => [c.method, c.params])).toEqual([["session.interrupt", { id: "agent-1" }], ["session.stop", { id: "agent-1" }]]);
    expect(toggles()).toEqual(["Session", "Browser"]);
  });

  test("Settings opens as a dialog over the tab; a card with no session (one Settings raised) closes it", async () => {
    const { approvals } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "go settings" }));
    await act(() => settle());
    expect(document.querySelector(".cl-window__dialog [data-stub='main:settings']")).toBeTruthy();
    expect(stubText("conversation")).toContain('"session":"s_alpha"');
    act(() => approvals.set([card("card-level")]));
    await act(() => settle());
    expect(document.querySelector(".cl-window__dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Answer the waiting card first, then open it again.");
  });

  test("a card in a session this window doesn't show holds nothing", async () => {
    const { approvals } = await mount({ route: { route: "settings", params: {} }, under: { route: "bot", params: { bot: "alpha" } } });
    act(() => approvals.set([card("c-luna", { session: "s_luna" })]));
    await act(() => settle());
    expect(document.querySelector(".cl-window__dialog [data-stub='main:settings']")).toBeTruthy();
  });

  test("a route no plugin fills says so; the status bar shows only when a plugin fills it", async () => {
    await mount({ route: { route: "usage", params: {} } });
    expect(screen.getByText("Nothing here yet")).toBeTruthy();
    expect(document.querySelector(".cl-window__status")).toBeNull();
    cleanup();
    await mount(undefined, [entry("clover-usage", "status", "Status")]);
    expect(document.querySelector(".cl-window__status [data-stub='status']")).toBeTruthy();
  });
});
