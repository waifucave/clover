import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Sidebar } from "../client/Sidebar";
import type { SidebarProps } from "../client/types";
import { BotTab, Window } from "../client/Window";
import { ACCOUNT, APPS, BOTS, PROJECTS } from "../gallery/fixtures";

afterEach(cleanup);

function setup(props: Partial<SidebarProps> = {}) {
  const handlers = {
    onSideChange: mock((_s: string) => undefined),
    onNavigate: mock((_r: unknown) => undefined),
    onOpenSettings: mock(() => undefined),
    onNew: mock(() => undefined),
    onSearch: mock(() => undefined),
    onOutputs: mock(() => undefined),
    onCustomize: mock(() => undefined),
    onMore: mock(() => undefined),
    onNewSession: mock((_p: string) => undefined),
    onCloseAgent: mock((_id: string) => undefined),
  };
  const result = render(
    <Sidebar side="bots" route={{ kind: "bot", botId: "alpha" }} bots={BOTS} projects={PROJECTS} apps={APPS} account={ACCOUNT} {...handlers} {...props} />,
  );
  return { ...result, ...handlers };
}

describe("the switch and the actions", () => {
  test("a switch between the bots and the code; each action reaches the host", () => {
    const h = setup();
    const bots = screen.getByRole("radio", { name: /Bots/ });
    expect(bots.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: /Code/ }));
    expect(h.onSideChange).toHaveBeenCalledWith("code");
    for (const [name, fn] of [
      ["New chat", h.onNew],
      ["Search", h.onSearch],
      ["Outputs", h.onOutputs],
      ["Customize", h.onCustomize],
      ["More", h.onMore],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  test("the account and the gear at the bottom open settings", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Account: Sam" }));
    expect(h.onOpenSettings).toHaveBeenCalledTimes(2);
  });
});

describe("the bots side", () => {
  test("each bot shows what it's doing and what needs the user; its agents are live tabs under it", () => {
    const h = setup();
    const luna = screen.getByRole("button", { name: /Luna/ });
    expect(within(luna).getByLabelText("2 things need you").textContent).toBe("2");
    expect(luna.textContent).toContain("Needs you");
    const agents = screen.getByRole("list", { name: "Alpha's agents" });
    expect(within(agents).getAllByRole("listitem")).toHaveLength(4);
    fireEvent.click(within(agents).getByRole("button", { name: /Rebuild the island/ }));
    expect(h.onNavigate).toHaveBeenCalledWith({ kind: "agent", agentId: "agent-island" });
  });

  test("a live tab's state comes before its title, so a long title never hides it", () => {
    setup();
    const row = screen.getByRole("button", { name: /Profile the hub/ });
    const parts = [...row.children].map((c) => c.className);
    expect(parts.indexOf("cl-sidebar__state")).toBeLessThan(parts.indexOf("cl-sidebar__title"));
    expect(row.querySelector(".cl-sidebar__state")?.textContent).toBe("Stalled");
  });

  test("Close is on finished tabs only, as a real button the keyboard reaches (review item 8)", () => {
    const h = setup();
    const close = screen.getByRole("button", { name: "Close Write the plugin SDK docs" });
    close.focus();
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(h.onCloseAgent).toHaveBeenCalledWith("agent-docs");
    expect(screen.queryByRole("button", { name: "Close Rebuild the island as a plugin" })).toBeNull();
  });

  test("sidebar.bot: a plugin can draw a bot's row its own way", () => {
    setup({ renderBot: (bot, standard) => (bot.id === "mira" ? <div data-testid="custom">Mira, drawn by a plugin</div> : standard) });
    expect(screen.getByTestId("custom").textContent).toBe("Mira, drawn by a plugin");
    expect(screen.queryByRole("button", { name: /^Mira/ })).toBeNull();
  });
});

describe("the code side", () => {
  test("sessions sit under their project folder, with their branch and change count", () => {
    const h = setup({ side: "code", route: { kind: "agent", agentId: "session-panels" } });
    const row = screen.getByRole("button", { name: /The panels as plugins/ });
    expect(row.getAttribute("aria-current")).toBe("page");
    expect(within(row).getByLabelText("On lane/f-m1, 14 files changed").textContent).toBe("14");
    fireEvent.click(screen.getByRole("button", { name: "New session in clover" }));
    expect(h.onNewSession).toHaveBeenCalledWith("clover");
    expect(screen.getByText("No sessions yet")).toBeTruthy();
  });

  test("a project folds and unfolds", () => {
    setup({ side: "code", initialFoldedProjects: ["tarot"] });
    expect(screen.queryByText("Three-card spread layout")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Unfold tarot-panel" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByText("Three-card spread layout")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fold clover" }));
    expect(screen.queryByText("The panels as plugins")).toBeNull();
  });
});

describe("banners and the rail", () => {
  test("safe mode, the pause switch and the link each say so, with their action", () => {
    const onResume = mock(() => undefined);
    const onOpenPluginManager = mock(() => undefined);
    setup({ safeMode: true, paused: true, onResume, onOpenPluginManager, link: { state: "unreachable", main: "Studio" } });
    expect(screen.getByText("Safe mode: only Clover's own plugins are running.")).toBeTruthy();
    expect(screen.getByText("Can't reach your main computer, Studio. Your bots wait for it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    fireEvent.click(screen.getByRole("button", { name: "Open the plugin manager" }));
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onOpenPluginManager).toHaveBeenCalledTimes(1);
  });

  test("collapsed, every row and banner keeps an accessible name, and the code side keeps its projects", () => {
    const onResume = mock(() => undefined);
    const { rerender } = setup({ collapsed: true, paused: true, onResume, link: { state: "offline" } });
    expect(screen.getByRole("button", { name: /^Luna, Needs you, 2 things need you$/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Every bot and routine is paused." }));
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Offline: other devices can't be reached." })).toBeTruthy();
    rerender(
      <Sidebar side="code" collapsed route={{ kind: "bot", botId: "alpha" }} bots={BOTS} projects={PROJECTS} account={ACCOUNT} onSideChange={() => undefined} onNavigate={() => undefined} onOpenSettings={() => undefined} />,
    );
    expect(screen.getByRole("button", { name: "clover: 3" })).toBeTruthy();
  });
});

describe("the window", () => {
  test("holds the sidebar, the title bar with its toggles, the main view, the session column, the panel and a dialog", () => {
    render(
      <Window
        sidebar={<div>sidebar</div>}
        title="The panels as plugins"
        onTitleMenu={() => undefined}
        toggles={<button type="button">Terminal</button>}
        side={<div>session</div>}
        panel={<div>panel</div>}
        dialog={<div role="dialog">settings</div>}
      >
        <BotTab conversation={<div>conversation</div>} composer={<div>composer</div>} />
      </Window>,
    );
    expect(screen.getByRole("button", { name: "The panels as plugins: options" })).toBeTruthy();
    expect(within(screen.getByRole("toolbar", { name: "Panels" })).getByRole("button", { name: "Terminal" })).toBeTruthy();
    for (const text of ["sidebar", "conversation", "composer", "session", "panel"]) expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toBe("settings");
  });
});
