// The column beside the conversation, on the runtime: a coding session's (`panel` keyed `session`).
import { computerView, fakeApi, fakeCore, settle, runtimeWith, TestLayer } from "@waifucave/moss-plugin-sdk/ui/testing";
import type { SessionView } from "@waifucave/moss-plugin-sdk";
import { afterEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SessionColumn } from "../client/entry";

afterEach(cleanup);

const s = (id: string, extra: Partial<SessionView>): SessionView => ({ id, kind: "agent", computer: "Studio", status: "idle", startedAt: 0, updatedAt: 0, ...extra });
const SESSIONS = [
  s("code-1", { kind: "coding", root: "home/Studio/projects/moss", title: "The panels", backend: "Codex" }),
  s("sub-1", { parent: "code-1", backend: "OpenCode", title: "Lint", status: "prompting" }),
  s("s_alpha", { kind: "bot", bot: "alpha" }),
  s("agent-1", { parent: "s_alpha", backend: "Codex", title: "Fix the dates", status: "prompting" }),
  s("task-1", { kind: "side-thread", parent: "s_alpha", title: "Weekly digest", status: "idle" }),
];

function mount(node: (navigate: (r: unknown) => void, open: (id: string) => void) => ReactNode) {
  const core = fakeCore({
    "session.changes": () => ({ label: "lane/f-m2", added: 120, removed: 30, files: 9, prs: [{ id: "p1", title: "F-M2", repo: "moss", number: 170, state: "open" }] }),
    "session.outputs": () => ({ items: [{ id: "o1", name: "Shell screens", kind: "page" }], more: 0 }),
    "session.context": () => ({ used: 0.2, tokens: 40_000, window: 200_000 }),
    "session.connectors": () => ({ total: 3, needSignIn: 1 }),
    "session.createPr": () => ({ ok: true }),
  });
  const api = fakeApi({
    sessions: { watch: () => () => undefined, history: async () => ({ events: [], hasMore: false }), follow: () => () => undefined,  get: async (id) => SESSIONS.find((x) => x.id === id)!, list: async () => SESSIONS },
    computers: { list: async () => [computerView("Studio", { device: "d1", level: "ask-risky", link: "self", isMain: true })] },
  });
  const routes: unknown[] = [];
  const opened: string[] = [];
  render(<TestLayer runtime={runtimeWith({ api: () => api, core: () => core })}>{node((r) => routes.push(r), (id) => opened.push(id))}</TestLayer>);
  return { core, routes, opened };
}

describe("the session column", () => {
  test("a coding session's: its agents, where it runs, context, connectors, outputs and changes", async () => {
    const { core, routes, opened } = mount((navigate, open) => <SessionColumn props={{ session: "code-1", sessionKind: "coding", navigate, onOpenAgent: open }} />);
    await act(() => settle());
    expect(screen.getByText("This computer")).toBeTruthy();
    expect(screen.getByText("Level: Ask when risky")).toBeTruthy();
    expect(screen.getByText("moss · ~/projects")).toBeTruthy();
    expect(screen.getByRole("meter", { name: "20% of the context used" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "1 to sign in again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Shell screens/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "lane/f-m2: 9 files, 120 added, 30 removed" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Lint/ }));
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));
    expect(opened).toEqual(["sub-1"]);
    expect(routes).toEqual([{ route: "settings", params: { section: "levels" } }]);
    expect(core.calls.filter((c) => c.method === "session.createPr").map((c) => c.params)).toEqual([{ id: "code-1" }]);
  });

  test("an agent's column has no changes: only a coding session's are read", async () => {
    const { core } = mount(() => <SessionColumn props={{ session: "agent-1", sessionKind: "agent" }} />);
    await act(() => settle());
    expect(core.calls.some((c) => c.method === "session.changes")).toBe(false);
    expect(screen.queryByRole("button", { name: /files, .* added/ })).toBeNull();
  });
});

