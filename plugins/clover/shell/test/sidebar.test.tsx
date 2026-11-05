import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { agentStatusLine, botStatusLine, sameRoute, Sidebar } from "../client/Sidebar";
import type { SidebarProps, SidebarRoute } from "../client/types";
import { ALPHA_AGENTS, APPS, BOTS, SESSIONS } from "../gallery/fixtures";

afterEach(cleanup);

function setup(props: Partial<SidebarProps> = {}) {
  const onNavigate = mock((_r: SidebarRoute) => undefined);
  render(<Sidebar bots={BOTS} sessions={SESSIONS} apps={APPS} route={{ kind: "bot", botId: "alpha" }} onNavigate={onNavigate} {...props} />);
  return { onNavigate: (props.onNavigate as typeof onNavigate | undefined) ?? onNavigate };
}

describe("pure helpers", () => {
  test("routes compare by kind and id", () => {
    expect(sameRoute({ kind: "bot", botId: "a" }, { kind: "bot", botId: "a" })).toBe(true);
    expect(sameRoute({ kind: "bot", botId: "a" }, { kind: "bot", botId: "b" })).toBe(false);
    expect(sameRoute({ kind: "agent", agentId: "x" }, { kind: "bot", botId: "x" })).toBe(false);
    expect(sameRoute({ kind: "settings" }, { kind: "settings" })).toBe(true);
    expect(sameRoute({ kind: "app", appId: "browser" }, { kind: "app", appId: "usage" })).toBe(false);
  });

  test("a bot's line: needs you, then asleep or paused, then what it does", () => {
    expect(botStatusLine({ id: "a", name: "A", status: "needs-you", activity: "Routine" })).toBe("Needs you");
    expect(botStatusLine({ id: "a", name: "A", status: "asleep", activity: "Routine" })).toBe("Asleep");
    expect(botStatusLine({ id: "a", name: "A", status: "idle", activity: "Morning brief running on Studio" })).toBe("Morning brief running on Studio");
    expect(botStatusLine({ id: "a", name: "A", status: "thinking" })).toBe("Thinking…");
    expect(botStatusLine({ id: "a", name: "A", status: "idle" })).toBe("");
  });

  test("an agent's line names its backend, computer and any finished state", () => {
    expect(agentStatusLine(ALPHA_AGENTS[0]!)).toBe("Claude Code · Studio");
    expect(agentStatusLine(ALPHA_AGENTS[1]!)).toBe("Codex · Laptop · Needs you");
    expect(agentStatusLine({ id: "x", title: "t", backend: "Grok", status: "completed" })).toBe("Grok · Done");
  });
});

describe("the sidebar", () => {
  test("lists bots with their lines and marks the open one", () => {
    setup();
    const nav = screen.getByRole("navigation", { name: "Clover" });
    const alpha = within(nav).getByRole("button", { name: /^Alpha/ });
    expect(alpha.getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("button", { name: /^Luna/ }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByText("Morning brief running on Studio")).toBeTruthy();
    expect(screen.getByTitle("2 things need you").textContent).toBe("2");
    expect(screen.getByTitle("New messages")).toBeTruthy();
  });

  test("each background agent is a live tab under its bot; a finished one can be closed", () => {
    const onCloseAgent = mock((_id: string) => undefined);
    const { onNavigate } = setup({ onCloseAgent });
    const agents = screen.getByRole("list", { name: "Alpha's agents" });
    expect(within(agents).getAllByRole("listitem").length).toBe(4);
    fireEvent.click(within(agents).getByRole("button", { name: /Fix the lint warnings/ }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: "agent", agentId: "agent-lint" });
    // Running and waiting agents have no close button; done and stalled ones do.
    expect(screen.queryByRole("button", { name: "Close Rebuild the island as a plugin" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close Fix the lint warnings" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close Write the plugin SDK docs" }));
    expect(onCloseAgent).toHaveBeenCalledWith("agent-docs");
    expect(screen.getByRole("button", { name: "Close Profile the hub's cold start" })).toBeTruthy();
  });

  test("navigates to bots, sessions, apps, plugins and settings", () => {
    const onNewSession = mock(() => undefined);
    const onNewBot = mock(() => undefined);
    const { onNavigate } = setup({ onNewSession, onNewBot });
    fireEvent.click(screen.getByRole("button", { name: /^Luna/ }));
    fireEvent.click(screen.getByRole("button", { name: /clover repo/ }));
    fireEvent.click(screen.getByRole("button", { name: /Discord Waifus/ }));
    fireEvent.click(screen.getByRole("button", { name: "Plugins" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onNavigate.mock.calls.map((c) => c[0])).toEqual([
      { kind: "bot", botId: "luna" },
      { kind: "agent", agentId: "session-clover" },
      { kind: "app", appId: "discord-waifus" },
      { kind: "plugins" },
      { kind: "settings" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Start a coding agent" }));
    fireEvent.click(screen.getByRole("button", { name: "New bot" }));
    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(onNewBot).toHaveBeenCalledTimes(1);
  });

  test("banners: safe mode, the pause switch and the link to the main computer", () => {
    const onOpenPluginManager = mock(() => undefined);
    const onResume = mock(() => undefined);
    setup({ safeMode: true, onOpenPluginManager, paused: true, onResume, link: { state: "unreachable", main: "Studio" } });
    const banners = screen.getAllByRole("status").map((b) => b.textContent);
    expect(banners).toEqual([
      "Safe mode: only Clover's own plugins are running.Open the plugin manager",
      "Every bot and routine is paused.Resume",
      "Can't reach your main computer, Studio. Your bots wait for it.",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Open the plugin manager" }));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onOpenPluginManager).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  test("a takeover and being offline say so; a healthy link says nothing", () => {
    setup({ link: { state: "takeover", main: "Studio", here: "Laptop" } });
    expect(screen.getByRole("status").textContent).toBe("Studio is offline, so Laptop runs your bots until it's back.");
    cleanup();
    setup({ link: { state: "offline" } });
    expect(screen.getByRole("status").textContent).toBe("Offline: other devices can't be reached.");
    cleanup();
    setup({ link: { state: "connected" } });
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("collapsed to a rail, every row still says what it is", () => {
    const onToggleCollapsed = mock(() => undefined);
    const { container } = render(
      <Sidebar bots={BOTS} sessions={SESSIONS} apps={APPS} route={{ kind: "bot", botId: "alpha" }} onNavigate={() => undefined} collapsed onToggleCollapsed={onToggleCollapsed} />,
    );
    expect(container.querySelector(".cl-sidebar")?.getAttribute("data-collapsed")).toBe("true");
    expect(screen.getByRole("button", { name: "Luna, Needs you, 2 things need you" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mira, New messages" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Browser" })).toBeTruthy();
    // Agents and sessions fold away; the headings stay for screen readers.
    expect(screen.queryByRole("list", { name: "Alpha's agents" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Bots" }).getAttribute("data-hidden")).toBe("true");
    const toggle = screen.getByRole("button", { name: "Show the sidebar" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
  });

  test("sidebar.bot: a plugin can draw a bot's row its own way", () => {
    setup({ renderBot: (bot, standard) => (bot.id === "luna" ? <div>custom Luna row</div> : standard) });
    expect(screen.getByText("custom Luna row")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Luna/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Alpha/ })).toBeTruthy();
  });
});
