// The default shell on the runtime: routes, the panels each tab offers (the owner's item 90), the dialog layer and its
// card rule, and the tabs it ships. The other parts stand in as stubs that show the props their spots got.
import * as React from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { UiEntry } from "../runtime/resolve";
import { card, fakeApi, fakeApprovals, fakeCore, settle } from "../runtime/testkit";
import type { BotView, EntryComponent, SessionView } from "../runtime/types";
import { runtimeWith } from "../runtime/ui";
import { SPOT_DECLS } from "../runtime/catalog";
import { DEFAULT_TAB_LAYOUT, layoutSpots } from "@waifucave/clover-plugin-sdk";
import { AgentTab, BotHeader, DefaultBotTab } from "../client/Tabs";
import { newestCoding, Shell, type ShellStart } from "../client/Shell";
import { KeptTab, notDrawn } from "../client/KeptTab";
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
    <button type="button" onClick={() => (props.navigate as (r: unknown) => void)({ route: "bot", params: { bot: "alpha" } })}>
      go alpha
    </button>
    <button type="button" onClick={() => (props.navigate as (r: unknown) => void)({ route: "bot", params: { bot: "luna" } })}>
      go luna
    </button>
    <button type="button" onClick={() => (props.navigate as (r: unknown) => void)({ route: "plugins", params: {} })}>
      go plugins
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

async function mount(start?: ShellStart, extra: UiEntry[] = [], kept?: Map<string, string>, onWatch?: (listener: (v: SessionView) => void) => void) {
  const core = fakeCore({ "session.interrupt": () => ({ ok: true }), "session.stop": () => ({ ok: true }) });
  const approvals = fakeApprovals();
  const api = fakeApi({
    bots: { list: async () => BOTS, get: async (id) => BOTS.find((b) => b.id === id)!, watch: () => () => undefined },
    conversation: { list: async () => SESSIONS, get: async (id) => SESSIONS.find((x) => x.id === id)!, watch: (l) => { onWatch?.(l); return () => undefined; } },
  });
  const runtime = runtimeWith({
    spot: (name) => SPOT_DECLS[name],
    entries: [...ENTRIES, ...extra],
    component: (_p, name) => COMPONENTS[name],
    api: () => api,
    core: () => core,
    approvals,
    sessionKind: (id) => SESSIONS.find((x) => x.id === id)?.kind,
    ...(kept ? { kept } : {}),
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

describe("the shell's session list", () => {
  test("a coding session started outside the window is known without a tab change: its tab gets the coding panels", async () => {
    let emit: ((v: SessionView) => void) | undefined;
    await mount({ route: { route: "agent", params: { session: "code-new" } } }, [], undefined, (l) => (emit = l));
    expect(toggles()).not.toContain("Terminal");
    await act(async () => emit!(s("code-new", { kind: "coding", root: "home/Studio/projects/cli", title: "From the CLI", startedAt: 5 })));
    await act(() => settle(6));
    expect(toggles()).toContain("Terminal");
  });

  test("the Code side goes to the newest coding session", () => {
    const list = [s("code-a", { kind: "coding", startedAt: 1 }), s("code-c", { kind: "coding", startedAt: 9 }), s("code-b", { kind: "coding", startedAt: 4 }), s("agent-x", { kind: "agent", startedAt: 20 })];
    expect(newestCoding(list)?.id).toBe("code-c");
    expect(newestCoding([s("agent-x", { kind: "agent" })])).toBeUndefined();
    // One that ended or was archived is not where the Code side goes.
    expect(newestCoding([...list, s("code-d", { kind: "coding", startedAt: 20, status: "stopped" }), s("code-e", { kind: "coding", startedAt: 30, archived: true })])?.id).toBe("code-c");
  });
});

describe("the shell", () => {
  test("opens on the first bot's tab: its conversation over its composer, the bot's toggles", async () => {
    await mount();
    expect(screen.getByRole("region", { name: "Alpha" })).toBeTruthy();
    expect(stubText("conversation")).toContain('"session":"s_alpha"');
    expect(stubText("composer")).toBe('composer {"bot":{"id":"alpha","name":"Alpha"},"session":"s_alpha"}');
    expect(toggles()).toEqual(["Details"]);
    expect(screen.getByRole("button", { name: "Edit Alpha" })).toBeTruthy();
    // A bot without an avatar has no stage, and the default tab has no header of its own.
    expect(document.querySelector(".cl-bot-tab__stage")).toBeNull();
    expect(document.querySelector(".cl-bot-header")).toBeNull();
  });

  test("where the user is outlives a reload of the window's document: the route, and Settings over the tab under it", async () => {
    const kept = new Map<string, string>();
    await mount(undefined, [], kept);
    fireEvent.click(screen.getByRole("button", { name: "go code" }));
    await act(() => settle(6));
    fireEvent.click(screen.getByRole("button", { name: "go settings" }));
    await act(() => settle(6));
    expect(document.querySelector(".cl-window__dialog [data-stub='main:settings']")).toBeTruthy();
    expect(stubText("sidebar")).toContain('{"route":"agent","params":{"session":"code-1"}}');
    // The document goes with no unmount (a reload runs no cleanup): the window's storage as it was.
    const atReload = new Map(kept);
    cleanup();
    expect(kept.size).toBe(0);
    await mount(undefined, [], atReload);
    // The same place from the first render: Settings, with the agent's tab under it (not the first bot's tab).
    expect(document.querySelector(".cl-window__dialog [data-stub='main:settings']")).toBeTruthy();
    expect(stubText("sidebar")).toContain('{"route":"agent","params":{"session":"code-1"}}');
    expect(stubText("conversation")).toContain('"session":"code-1"');
    expect(JSON.parse(atReload.get("clover.kept:clover/shell:shell.under")!)).toEqual({ route: "agent", params: { session: "code-1" } });
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
    await mount({ route: { route: "agent", params: { session: "code-1" } }, panels: ["session", "browser"] }, [entry("clover/browser-view", "panel", "Browser", { key: "browser" })]);
    expect(toggles()).toEqual(["Session", "Terminal", "Browser"]);
    expect(stubText("panel:browser")).toContain('"app":"browser"');
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

  test("the agent tab has no interrupt or stop button until the host callbacks cover them (no bare core call)", async () => {
    const { core } = await mount({ route: { route: "agent", params: { session: "agent-1" } } });
    expect(screen.queryByRole("button", { name: "Interrupt" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(core.calls.some((c) => c.method === "session.interrupt" || c.method === "session.stop")).toBe(false);
    expect(toggles()).toEqual(["Session"]);
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

describe("a bot's own layout's header", () => {
  const withAvatar: BotView = { ...bot("luna", "Luna"), model: "anthropic/claude-sonnet-5-5", portrait: "/_t/luna/p.svg", avatar: { src: "/_t/luna/a.vrm", format: "vrm" } };
  async function mountPart(Part: EntryComponent, b: BotView) {
    const api = fakeApi({ bots: { list: async () => [b], get: async () => b, watch: () => () => undefined } });
    const AvatarStub: EntryComponent = ({ props }) => <div data-stub="avatar">{JSON.stringify(props)}</div>;
    const runtime = runtimeWith({
      api: () => api,
      core: () => fakeCore({}),
      approvals: fakeApprovals(),
      spot: (name) => SPOT_DECLS[name],
      entries: [{ pluginId: "clover/vrm", id: "vrm", spot: "avatar", key: "vrm", component: "VrmAvatar" } as UiEntry],
      component: (_p, name) => (name === "VrmAvatar" ? AvatarStub : undefined),
    });
    render(<UiRuntimeProvider runtime={runtime}>{React.createElement(Part as never, { props: { bot: { id: b.id, name: b.name } } } as never)}</UiRuntimeProvider>);
    await act(() => settle(6));
  }

  test("the default tab draws the stock layout's parts in its order (`extends: \"default\"` means this tab)", async () => {
    const api = fakeApi({ bots: { list: async () => [withAvatar], get: async () => withAvatar, watch: () => () => undefined } });
    const Stub = (label: string): EntryComponent => () => <div data-part={label} />;
    const runtime = runtimeWith({
      api: () => api,
      core: () => fakeCore({}),
      approvals: fakeApprovals(),
      spot: (name) => SPOT_DECLS[name],
      entries: [
        { pluginId: "clover/character", id: "stage", spot: "bot.stage", component: "Stage" } as UiEntry,
        { pluginId: "clover/conversation", id: "conversation", spot: "conversation", component: "Conversation" } as UiEntry,
        { pluginId: "clover/composer", id: "composer", spot: "composer", component: "Composer" } as UiEntry,
      ],
      component: (_p, name) => (name === "Stage" ? Stub("bot.stage") : name === "Conversation" ? Stub("conversation") : name === "Composer" ? Stub("composer") : undefined),
    });
    render(<UiRuntimeProvider runtime={runtime}>{React.createElement(DefaultBotTab as never, { props: { bot: { id: "luna", name: "Luna" } } } as never)}</UiRuntimeProvider>);
    await act(() => settle(6));
    expect([...document.querySelectorAll("[data-part]")].map((e) => e.getAttribute("data-part"))).toEqual(layoutSpots(DEFAULT_TAB_LAYOUT.root));
  });

  test("the header names the bot and its model", async () => {
    await mountPart(BotHeader as EntryComponent, withAvatar);
    expect(document.querySelector(".cl-bot-header")!.textContent).toContain("Luna");
    expect(document.querySelector(".cl-bot-header")!.textContent).toContain("claude-sonnet-5-5");
  });

  test("an app's title bar says its name from the route's `title` (the shell does not list the sidebar's apps itself), the key when none", async () => {
    await mount({ route: { route: "reel", params: { title: "Reel" } } });
    expect(document.querySelector(".cl-window__title-text")?.textContent).toBe("Reel");
    cleanup();
    await mount({ route: { route: "reel", params: {} } });
    expect(document.querySelector(".cl-window__title-text")?.textContent).toBe("reel");
  });
});

// The owner's report on try 14d: coming back to Alpha's tab from an app's page drew the stock layout and an empty
// conversation for a moment. The last bot tab shown stays mounted while another page shows, and a tab showing with
// something not drawn yet is held invisible until it is (or the cap).
describe("the bot tab kept across pages", () => {
  const kept = () => [...document.querySelectorAll(".cl-shell-kept")] as HTMLElement[];
  const go = async (name: string) => {
    fireEvent.click(screen.getByRole("button", { name }));
    await act(() => settle(6));
  };

  test("leaving a bot's tab keeps it mounted, hidden and inert; coming back shows the same element, not a new one", async () => {
    await mount();
    const [tab] = kept();
    expect(tab?.hasAttribute("data-shown")).toBe(true);
    const conversation = tab!.querySelector("[data-stub='conversation']");
    expect(conversation?.textContent).toContain('"session":"s_alpha"');
    // Another page (the plugins page here, an app's page alike): the bot tab is there, not shown, and takes no input.
    await go("go plugins");
    expect(kept()).toEqual([tab!]);
    expect(tab!.style.display).toBe("none");
    expect(tab!.hasAttribute("inert")).toBe(true);
    expect(tab!.getAttribute("aria-hidden")).toBe("true");
    // Back: the very same element and conversation, shown, with nothing to rebuild.
    await go("go alpha");
    expect(kept()).toEqual([tab!]);
    expect(tab!.hasAttribute("data-shown")).toBe(true);
    expect(tab!.style.display).toBe("contents");
    expect(tab!.querySelector("[data-stub='conversation']")).toBe(conversation);
    // Settings is a dialog over the tab: the tab stays shown under it.
    await go("go settings");
    expect(kept()[0]).toBe(tab!);
    expect(tab!.hasAttribute("data-shown")).toBe(true);
  });

  test("one tab is kept: another bot's tab takes the place; an agent's tab is never kept", async () => {
    await mount();
    await go("go luna");
    expect(kept().length).toBe(1);
    expect(kept()[0]!.querySelector("[data-stub='conversation']")?.textContent).toContain('"session":"s_luna"');
    await go("go code");
    expect(kept().length).toBe(1);
    expect(kept()[0]!.hasAttribute("data-shown")).toBe(false);
    expect(kept()[0]!.querySelector("[data-stub='conversation']")?.textContent).toContain('"session":"s_luna"');
  });

  test("what of a tab isn't drawn yet, by the runtime's marks", () => {
    const root = document.createElement("div");
    expect(notDrawn(root)).toEqual(["no part yet"]);
    root.innerHTML = `<div data-clover-entry="alpha#layout" data-clover-part="m1"><div data-clover-spot="bot.side" data-clover-pending=""></div><iframe data-clover-entry="alpha#room"></iframe><div data-clover-entry="alpha#header" data-clover-asleep=""></div><div class="cl-shell-empty"></div></div>`;
    expect(notDrawn(root)).toEqual(["spot bot.side resolving", "alpha#room loading", "alpha#header asleep", "loading note"]);
    root.innerHTML = `<div data-clover-entry="alpha#layout" data-clover-part="m1"><div data-clover-spot="bot.side"></div><iframe data-clover-entry="alpha#room" data-clover-drawn=""></iframe></div>`;
    expect(notDrawn(root)).toEqual([]);
  });

  test("a tab that shows with a frame not drawn is held invisible until it draws, at most the cap", async () => {
    const frame = (drawn: boolean) => <iframe data-clover-entry="alpha#room" {...(drawn ? { "data-clover-drawn": "" } : {})} />;
    const { rerender } = render(<KeptTab shown={true}>{frame(false)}</KeptTab>);
    const box = document.querySelector(".cl-shell-kept") as HTMLElement;
    expect(box.hasAttribute("data-held")).toBe(true);
    expect(box.style.visibility).toBe("hidden");
    rerender(<KeptTab shown={true}>{frame(true)}</KeptTab>);
    await act(() => new Promise((r) => setTimeout(r, 60)));
    expect(box.hasAttribute("data-held")).toBe(false);
    expect(box.style.visibility).toBe("");
    cleanup();
    // Never drawn: shown anyway at the cap.
    render(<KeptTab shown={true} holdMaxMs={80}>{frame(false)}</KeptTab>);
    const capped = document.querySelector(".cl-shell-kept") as HTMLElement;
    expect(capped.hasAttribute("data-held")).toBe(true);
    await act(() => new Promise((r) => setTimeout(r, 200)));
    expect(capped.hasAttribute("data-held")).toBe(false);
    cleanup();
    // Drawn already (the kept tab coming back): never held.
    render(<KeptTab shown={true}><div data-clover-entry="clover/shell#x" /></KeptTab>);
    expect((document.querySelector(".cl-shell-kept") as HTMLElement).hasAttribute("data-held")).toBe(false);
  });
});
