// The column beside the conversation, on the runtime: a coding session's (`panel` keyed `session`) and a bot's slim
// one (`bot.side`, the owner's item 90).
import { afterEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { computerView, fakeApi, fakeCore, settle } from "../../shell/runtime/testkit";
import type { SessionView } from "../../shell/runtime/types";
import { runtimeWith } from "../../shell/runtime/ui";
import { BotColumn, SessionColumn } from "../client/entry";
import { UiRuntimeProvider } from "../client/sdk";

afterEach(cleanup);

const s = (id: string, extra: Partial<SessionView>): SessionView => ({ id, kind: "agent", computer: "Studio", status: "idle", startedAt: 0, updatedAt: 0, ...extra });
const SESSIONS = [
  s("code-1", { kind: "coding", root: "home/Studio/projects/clover", title: "The panels", backend: "Codex" }),
  s("sub-1", { parent: "code-1", backend: "OpenCode", title: "Lint", status: "prompting" }),
  s("s_alpha", { kind: "bot", bot: "alpha" }),
  s("agent-1", { parent: "s_alpha", backend: "Codex", title: "Fix the dates", status: "prompting" }),
  s("task-1", { kind: "side-thread", parent: "s_alpha", title: "Weekly digest", status: "idle" }),
];

function mount(node: (navigate: (r: unknown) => void, open: (id: string) => void) => ReactNode) {
  const core = fakeCore({
    "session.changes": () => ({ label: "lane/f-m2", added: 120, removed: 30, files: 9 }),
    "session.outputs": () => ({ items: [{ id: "o1", name: "Shell screens", kind: "page" }], more: 0 }),
    "session.context": () => ({ used: 0.2, tokens: 40_000, window: 200_000 }),
    "session.connectors": () => ({ total: 3, needSignIn: 1 }),
  });
  const api = fakeApi({
    conversation: { get: async (id) => SESSIONS.find((x) => x.id === id)!, list: async () => SESSIONS },
    computers: { list: async () => [computerView("Studio", { device: "d1", level: "ask-risky", link: "self", isMain: true })] },
  });
  const routes: unknown[] = [];
  const opened: string[] = [];
  render(<UiRuntimeProvider runtime={runtimeWith({ api: () => api, core: () => core })}>{node((r) => routes.push(r), (id) => opened.push(id))}</UiRuntimeProvider>);
  return { core, routes, opened };
}

describe("the session column", () => {
  test("a coding session's: its agents, where it runs, context, connectors, outputs and changes", async () => {
    const { routes, opened } = mount((navigate, open) => <SessionColumn props={{ session: "code-1", sessionKind: "coding", navigate, onOpenAgent: open }} />);
    await act(() => settle());
    expect(screen.getByText("This computer")).toBeTruthy();
    expect(screen.getByText("Level: Ask when risky")).toBeTruthy();
    expect(screen.getByText("clover · ~/projects")).toBeTruthy();
    expect(screen.getByRole("meter", { name: "20% of the context used" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1 to sign in again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Shell screens/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "lane/f-m2: 9 files, 120 added, 30 removed" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Lint/ }));
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(opened).toEqual(["sub-1"]);
    expect(routes).toEqual([{ route: "settings", params: { section: "levels" } }]);
  });

  test("an agent's column has no changes: only a coding session's are read", async () => {
    const { core } = mount(() => <SessionColumn props={{ session: "agent-1", sessionKind: "agent" }} />);
    await act(() => settle());
    expect(core.calls.some((c) => c.method === "session.changes")).toBe(false);
    expect(screen.queryByRole("button", { name: /files, .* added/ })).toBeNull();
  });
});

describe("a bot's slim column", () => {
  test("its agents and tasks, context and outputs; an agent opens in the panel", async () => {
    const { opened } = mount((_n, open) => <BotColumn props={{ bot: { id: "alpha", name: "Alpha" }, session: "s_alpha", openAgent: "agent-1", onOpenAgent: open }} />);
    await act(() => settle());
    for (const title of ["Agents and tasks", "Context", "Outputs"]) expect(screen.getByText(title)).toBeTruthy();
    expect(screen.queryByText("This computer")).toBeNull();
    const agent = screen.getByRole("button", { name: /Fix the dates/ });
    expect(agent.getAttribute("aria-current")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Weekly digest/ }));
    expect(opened).toEqual(["task-1"]);
  });
});
