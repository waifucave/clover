// The terminal on the runtime: a shell on the session's computer, in its folder, through the plugin API's `terminal`.
import { fakeApi, settle, runtimeWith, TestLayer } from "@waifucave/moss-plugin-sdk/ui/testing";
import type { SessionView } from "@waifucave/moss-plugin-sdk";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TerminalEntry } from "../client/entry";

afterEach(cleanup);

const CODE: SessionView = { id: "code-1", kind: "coding", computer: "Laptop", root: "home/Laptop/code/tarot", status: "idle", startedAt: 0, updatedAt: 0 };

describe("the terminal entry", () => {
  test("opens in the session's folder on its computer, shows what comes back, and sends keys and pastes apart", async () => {
    const opens: unknown[] = [];
    const writes: unknown[] = [];
    const feeds = new Map<string, (data: string, exited?: { code: number | null }) => void>();
    let n = 0;
    const api = fakeApi({
      sessions: { list: async () => [], watch: () => () => undefined, history: async () => ({ events: [], hasMore: false }), follow: () => () => undefined,  get: async () => CODE },
      terminal: {
        open: async (o) => {
          opens.push(o);
          return { terminalId: `t${++n}` };
        },
        input: async (id, event) => void writes.push([id, event.type, (event as unknown as KeyboardEvent).key ?? null]),
        onData: (id, fn) => {
          feeds.set(id, fn);
          return () => feeds.delete(id);
        },
        resize: async () => undefined,
        close: async () => undefined,
      },
    });
    const header = document.createElement("div");
    document.body.append(header);
    render(
      <TestLayer runtime={runtimeWith({ api: () => api })}>
        <TerminalEntry props={{ session: "code-1", header }} />
      </TestLayer>,
    );
    await act(() => settle());
    expect(opens).toEqual([{ computer: "Laptop", cwd: "home/Laptop/code/tarot", session: "code-1", cols: 100, rows: 30 }]);
    act(() => feeds.get("t1")!("$ bun test\n"));
    expect(screen.getByRole("log").textContent).toContain("$ bun test");
    fireEvent.keyDown(screen.getByRole("log"), { key: "l" });
    fireEvent.paste(screen.getByRole("log"), { clipboardData: { getData: () => "echo a\necho b\n" } });
    // Each goes as the event itself: the runtime derives the bytes from a trusted one.
    expect(writes).toEqual([["t1", "keydown", "l"], ["t1", "paste", null]]);
    // Its tabs sit in the panel's header row.
    expect(header.querySelector('[role="tab"]')?.textContent).toBe("Laptop 1");
    fireEvent.click(header.querySelector('[aria-label="New terminal"]')!);
    await act(() => settle());
    expect(opens).toHaveLength(2);
    act(() => feeds.get("t2")!("", { code: 0 }));
    expect(screen.getByRole("log").textContent).toContain("Exited with code 0");
    header.remove();
  });
});
