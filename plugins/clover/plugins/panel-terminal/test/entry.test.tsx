// The terminal on the runtime: a shell on the session's computer, in its folder, through the plugin API's `terminal`.
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { fakeApi, settle } from "../../shell/runtime/testkit";
import type { SessionView } from "../../shell/runtime/types";
import { runtimeWith } from "../../shell/runtime/ui";
import { TerminalEntry } from "../client/entry";
import { UiRuntimeProvider } from "../client/sdk";

afterEach(cleanup);

const CODE: SessionView = { id: "code-1", kind: "coding", computer: "Laptop", root: "home/Laptop/code/tarot", status: "idle", startedAt: 0, updatedAt: 0 };

describe("the terminal entry", () => {
  test("opens in the session's folder on its computer, shows what comes back, and sends keys and pastes apart", async () => {
    const opens: unknown[] = [];
    const writes: unknown[] = [];
    const feeds = new Map<string, (data: string, exited?: { code: number | null }) => void>();
    let n = 0;
    const api = fakeApi({
      conversation: { get: async () => CODE },
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
      <UiRuntimeProvider runtime={runtimeWith({ api: () => api })}>
        <TerminalEntry props={{ session: "code-1", header }} />
      </UiRuntimeProvider>,
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

  test("its output is read as a terminal does (colours, no escape codes), and closing the panel ends its shells", async () => {
    const closed: string[] = [];
    const feeds = new Map<string, (data: string) => void>();
    let n = 0;
    const api = fakeApi({
      conversation: { get: async () => CODE },
      terminal: {
        open: async () => ({ terminalId: `t${++n}` }),
        input: async () => undefined,
        onData: (id, fn) => {
          feeds.set(id, fn);
          return () => feeds.delete(id);
        },
        resize: async () => undefined,
        close: async (id) => void closed.push(id),
      },
    });
    const { unmount } = render(
      <UiRuntimeProvider runtime={runtimeWith({ api: () => api })}>
        <TerminalEntry props={{ session: "code-1" }} />
      </UiRuntimeProvider>,
    );
    await act(() => settle());
    act(() => feeds.get("t1")!("\x1b]0;title\x07\x1b[32m3 pass\x1b[0m\r\n\x1b[31m0 fail\x1b[0m"));
    const log = screen.getByRole("log");
    expect(log.textContent).not.toContain("\x1b");
    expect(log.textContent).not.toContain("title");
    expect([...log.querySelectorAll(".cl-term__run[data-fg]")].map((r) => [r.textContent, r.getAttribute("data-fg")])).toEqual([["3 pass", "green"], ["0 fail", "red"]]);
    unmount();
    expect(closed).toEqual(["t1"]);
  });
});
