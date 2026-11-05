// The sidebar on the runtime: bots, coding projects and app buttons from the API, and routes to the shell.
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { fakeApi, fakeCore, settle } from "../../shell/runtime/testkit";
import type { BotView, EntryComponent, SessionView } from "../../shell/runtime/types";
import { runtimeWith } from "../../shell/runtime/ui";
import { agentStatus, botStatus, SidebarEntry, toShellRoute, toSidebarRoute, type ShellRoute } from "../client/entry";
import { UiRuntimeProvider } from "../client/sdk";

afterEach(cleanup);

const bot = (id: string, name: string, extra: Partial<BotView> = {}): BotView => ({ id, name, model: "m", userLayer: [], state: "idle", mainSession: `s_${id}`, ...extra });
const s = (id: string, extra: Partial<SessionView>): SessionView => ({ id, kind: "agent", computer: "Studio", status: "idle", startedAt: 0, updatedAt: 0, ...extra });

const BOTS = [bot("alpha", "Alpha", { state: "thinking" }), bot("luna", "Luna")];
const SESSIONS = [
  s("s_alpha", { kind: "bot", bot: "alpha", status: "prompting" }),
  s("s_luna", { kind: "bot", bot: "luna", needsYou: { cards: 1, questions: 0 } }),
  s("agent-1", { parent: "s_alpha", bot: "alpha", backend: "Codex", title: "Fix the dates", status: "prompting" }),
  s("code-1", { kind: "coding", root: "home/Studio/projects/clover", title: "The panels", backend: "Codex" }),
  s("code-2", { kind: "coding", root: "home/Studio/projects/clover", title: "The docs", status: "failed" }),
  s("code-3", { kind: "coding", root: "home/Laptop/code/tarot", title: "Spreads" }),
];

async function mount(route: ShellRoute = { route: "bot", params: { bot: "alpha" } }, opts: { entries?: Parameters<typeof runtimeWith>[0]["entries"]; component?: EntryComponent } = {}) {
  const core = fakeCore({ "account.status": () => ({ signedIn: true, user: { id: "u1", name: "Sam" } }) });
  const api = fakeApi({
    bots: { list: async () => BOTS, get: async (id) => BOTS.find((b) => b.id === id)!, watch: () => () => undefined },
    conversation: { list: async () => SESSIONS },
    computers: { list: async () => [{ name: "Studio", device: "d1", os: "macos", level: "ask", state: "online", link: "self", isMain: true, agents: [] }] },
  });
  const routes: ShellRoute[] = [];
  const runtime = runtimeWith({
    api: () => api,
    core: () => core,
    spot: (name) => (name === "sidebar.app" ? { shape: "list" } : name === "sidebar.bot" ? { shape: "keyed" } : undefined),
    entries: opts.entries ?? [
      { pluginId: "clover/archive", id: "archive-app", spot: "sidebar.app", component: "ArchiveAppBadge", fields: { title: "Archive", icon: "assets/archive.svg", opens: "archive" }, order: 900, source: "bundled", enabledAt: 0 },
      { pluginId: "discord-waifus", id: "app", spot: "sidebar.app", component: "Badge", fields: { title: "Discord Waifus", icon: "clover-asset://discord-waifus/dw.png", opens: "discord-waifus" }, source: "installed", enabledAt: 0 },
    ],
    component: () => opts.component,
  });
  render(
    <UiRuntimeProvider runtime={runtime}>
      <SidebarEntry props={{ route, navigate: (r) => routes.push(r) }} />
    </UiRuntimeProvider>,
  );
  await act(() => settle());
  return { routes };
}

describe("the sidebar entry", () => {
  test("routes map both ways", () => {
    const all: ShellRoute[] = [{ route: "bot", params: { bot: "alpha" } }, { route: "agent", params: { session: "a" } }, { route: "settings", params: {} }, { route: "plugins", params: {} }, { route: "archive", params: {} }];
    for (const r of all) {
      expect(toShellRoute(toSidebarRoute(r))).toEqual(r);
    }
  });

  test("states: what waits for the user comes first", () => {
    expect(agentStatus(s("x", { status: "prompting", needsYou: { cards: 0, questions: 1 } }))).toBe("needs-you");
    expect(agentStatus(s("x", { status: "failed", failure: "stalled" }))).toBe("stalled");
    expect(botStatus(bot("a", "A", { state: "thinking" }), s("m", { status: "prompting" }))).toBe("working");
    expect(botStatus(bot("a", "A", { state: "asleep" }), s("m", { needsYou: { cards: 1, questions: 0 } }))).toBe("needs-you");
  });

  test("the bots, each with its agents, the account and the apps", async () => {
    const { routes } = await mount();
    expect(screen.getByRole("button", { name: "Account: Sam" })).toBeTruthy();
    const agents = screen.getByRole("list", { name: "Alpha's agents" });
    fireEvent.click(within(agents).getByRole("button", { name: /Fix the dates/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Luna/ }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    fireEvent.click(screen.getByRole("button", { name: /Discord Waifus/ }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(routes).toEqual([
      { route: "agent", params: { session: "agent-1" } },
      { route: "bot", params: { bot: "luna" } },
      { route: "archive", params: {} },
      { route: "discord-waifus", params: {} },
      { route: "settings", params: {} },
    ]);
    // A bundled app wears the shell's own glyph; a third party's, its icon.
    expect(screen.getByRole("button", { name: /Discord Waifus/ }).querySelector("img")?.getAttribute("src")).toBe("clover-asset://discord-waifus/dw.png");
    expect(screen.getByRole("button", { name: "Archive" }).querySelector("img")).toBeNull();
  });

  test("the code side groups coding sessions by their folder; a coding session's tab opens on it", async () => {
    const { routes } = await mount({ route: "agent", params: { session: "code-1" } });
    expect(screen.getByRole("radio", { name: /Code/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: /The panels/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /The docs/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fold tarot" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Spreads/ }));
    expect(routes).toEqual([{ route: "agent", params: { session: "code-3" } }]);
  });

  test("a plugin that fills `sidebar.bot` for a bot draws its row", async () => {
    const Row: EntryComponent = ({ props }) => <p>{`custom ${(props.bot as { name: string }).name} ${String(props.selected)}`}</p>;
    await mount(undefined, { component: Row, entries: [{ pluginId: "alpha", id: "row", spot: "sidebar.bot", key: "alpha", component: "Row", source: "installed", enabledAt: 1 }] });
    expect(screen.getByText("custom Alpha true")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Luna/ })).toBeTruthy();
  });
});
