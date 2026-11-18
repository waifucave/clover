// The sidebar on the runtime: code sessions by project and app buttons from the API, and routes to the shell. MOSS
// Code's window has no bots (spec §9.4): the sidebar reads code sessions only (`sessions.read`).
import { computerView, fakeApi, fakeCore, settle, runtimeWith, TestLayer } from "@waifucave/moss-plugin-sdk/ui/testing";
import type { SessionView } from "@waifucave/moss-plugin-sdk";
import type { EntryComponent } from "../client/local";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { agentStatus, SidebarEntry, toShellRoute, toSidebarRoute, type ShellRoute } from "../client/entry";

afterEach(cleanup);

const s = (id: string, extra: Partial<SessionView>): SessionView => ({ id, kind: "agent", computer: "Studio", status: "idle", startedAt: 0, updatedAt: 0, ...extra });

const SESSIONS = [
  s("agent-1", { parent: "s_alpha", bot: "alpha", backend: "Codex", title: "Fix the dates", status: "prompting" }),
  s("code-1", { kind: "coding", root: "home/Studio/projects/moss", title: "The panels", backend: "Codex" }),
  s("code-2", { kind: "coding", root: "home/Studio/projects/moss", title: "The docs", status: "failed" }),
  s("code-3", { kind: "coding", root: "home/Laptop/code/tarot", title: "Spreads" }),
];

async function mount(route: ShellRoute = { route: "agent", params: { session: "code-1" } }, opts: { entries?: Parameters<typeof runtimeWith>[0]["entries"]; component?: EntryComponent; onWatch?: (listener: (s: SessionView) => void) => void } = {}) {
  const core = fakeCore({ "account.status": () => ({ signedIn: true, user: { id: "u1", name: "Sam" } }) });
  const api = fakeApi({
    sessions: { list: async () => SESSIONS, get: async (id) => SESSIONS.find((x) => x.id === id)!, watch: (l) => { opts.onWatch?.(l); return () => undefined; }, history: async () => ({ events: [], hasMore: false }), follow: () => () => undefined },
    computers: { list: async () => [computerView("Studio", { device: "d1", level: "ask", link: "self", isMain: true })] },
  });
  const routes: ShellRoute[] = [];
  const runtime = runtimeWith({
    api: () => api,
    core: () => core,
    spot: (name) => (name === "sidebar.app" ? { shape: "list" } : undefined),
    entries: opts.entries ?? [
      { pluginId: "moss/archive", id: "archive-app", spot: "sidebar.app", component: "ArchiveAppBadge", fields: { title: "Archive", icon: "assets/archive.svg", opens: "archive" }, order: 900, source: "bundled", enabledAt: 0 },
      { pluginId: "discord-waifus", id: "app", spot: "sidebar.app", component: "Badge", fields: { title: "Discord Waifus", icon: "moss-asset://discord-waifus/dw.png", opens: "discord-waifus" }, source: "installed", enabledAt: 0 },
    ],
    component: () => opts.component,
  });
  render(
    <TestLayer runtime={runtime}>
      <SidebarEntry props={{ route, navigate: (r) => routes.push(r) }} />
    </TestLayer>,
  );
  await act(() => settle());
  return { routes };
}

describe("the sidebar entry", () => {
  test("routes map both ways; a bot's route has no place here", () => {
    const all: ShellRoute[] = [{ route: "new", params: {} }, { route: "agent", params: { session: "a" } }, { route: "settings", params: {} }, { route: "plugins", params: {} }, { route: "archive", params: {} }];
    for (const r of all) {
      expect(toShellRoute(toSidebarRoute(r))).toEqual(r);
    }
  });

  test("states: what waits for the user comes first", () => {
    expect(agentStatus(s("x", { status: "prompting", needsYou: { cards: 0, questions: 1 } }))).toBe("needs-you");
    expect(agentStatus(s("x", { status: "failed", failure: "stalled" }))).toBe("stalled");
    // A coding session whose turn failed stays open (idle) and reads failed, not done, until a turn ends well.
    expect(agentStatus(s("x", { status: "idle", failure: "error" }))).toBe("failed");
    expect(agentStatus(s("x", { status: "idle", failure: "stalled" }))).toBe("stalled");
    expect(agentStatus(s("x", { status: "idle" }))).toBe("completed");
  });

  test("a coding session started outside the window shows without a remount, and a change to it is followed", async () => {
    let emit: ((v: SessionView) => void) | undefined;
    await mount(undefined, { onWatch: (l) => (emit = l) });
    expect(emit).toBeDefined();
    expect(screen.queryByText("From the CLI")).toBeNull();
    await act(async () => emit!(s("code-9", { kind: "coding", root: "home/Studio/projects/cli", title: "From the CLI", status: "ready" })));
    expect(screen.getByText("From the CLI")).toBeTruthy();
    await act(async () => emit!(s("code-9", { kind: "coding", root: "home/Studio/projects/cli", title: "Renamed by the CLI", status: "ready" })));
    expect(screen.queryByText("From the CLI")).toBeNull();
    expect(screen.getByText("Renamed by the CLI")).toBeTruthy();
    // A session that is archived leaves the list; one that stopped or failed stays, marked.
    await act(async () => emit!(s("code-9", { kind: "coding", root: "home/Studio/projects/cli", title: "Renamed by the CLI", status: "stopped" })));
    expect(screen.getByText("Renamed by the CLI")).toBeTruthy();
    await act(async () => emit!(s("code-9", { kind: "coding", root: "home/Studio/projects/cli", title: "Back again", status: "ready" })));
    expect(screen.getByText("Back again")).toBeTruthy();
    await act(async () => emit!(s("code-9", { kind: "coding", root: "home/Studio/projects/cli", title: "Back again", status: "idle", archived: true })));
    expect(screen.queryByText("Back again")).toBeNull();
    await act(async () => emit!(s("code-8", { kind: "coding", root: "home/Studio/projects/cli", title: "Broke", status: "failed" })));
    expect(screen.getByText("Broke")).toBeTruthy();
  });


  test("no bot and no switch; a bot's coding task is a code session under its folder; the account, New and the apps", async () => {
    const { routes } = await mount();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByRole("button", { name: "Account: Sam" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Fix the dates/ }));
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    fireEvent.click(screen.getByRole("button", { name: /Discord Waifus/ }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(routes).toEqual([
      { route: "agent", params: { session: "agent-1" } },
      { route: "new", params: {} },
      { route: "archive", params: { title: "Archive" } },
      { route: "discord-waifus", params: { title: "Discord Waifus" } },
      { route: "settings", params: {} },
    ]);
    // A bundled app wears the shell's own glyph; a third party's, its icon.
    expect(screen.getByRole("button", { name: /Discord Waifus/ }).querySelector("img")?.getAttribute("src")).toBe("moss-asset://discord-waifus/dw.png");
    expect(screen.getByRole("button", { name: "Archive" }).querySelector("img")).toBeNull();
  });

  test("an app whose title is words by language (a plugin's manifest may say it so) is listed in the user's words, not dropped", async () => {
    const { routes } = await mount(undefined, { entries: [
      { pluginId: "example-notes", id: "notes-app", spot: "sidebar.app", component: "NotesBadge", fields: { title: { en: "Notes", ja: "ノート" }, icon: "moss-asset://example-notes/icon.svg", opens: "example-notes" }, source: "installed", enabledAt: 0 },
      { pluginId: "odd", id: "odd-app", spot: "sidebar.app", component: "Badge", fields: { title: { ja: "英語なし" }, opens: "odd" }, source: "installed", enabledAt: 0 },
    ] });
    fireEvent.click(screen.getByRole("button", { name: /Notes/ }));
    expect(routes).toEqual([{ route: "example-notes", params: { title: "Notes" } }]);
    // A map with no English is no title: that entry isn't listed.
    expect(screen.queryByRole("button", { name: /英語なし/ })).toBeNull();
  });


  test("code sessions are grouped by their folder; a coding session's tab opens on it", async () => {
    const { routes } = await mount({ route: "agent", params: { session: "code-1" } });
    expect(screen.getByRole("button", { name: /The panels/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /The docs/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fold tarot" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Spreads/ }));
    expect(routes).toEqual([{ route: "agent", params: { session: "code-3" } }]);
  });

});
