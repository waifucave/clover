import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { BotTab, Window, skinOf, type WindowProps } from "../client/Window";

afterEach(cleanup);

function frame(props: Partial<WindowProps> = {}) {
  return (
    <Window
      sidebar={<div>sidebar</div>}
      title="The panels as plugins"
      onTitleMenu={() => undefined}
      toggles={<button type="button">Terminal</button>}
      side={<div>session</div>}
      panel={<div>panel</div>}
      {...props}
    >
      <BotTab conversation={<div>conversation</div>} composer={<div>composer</div>} />
    </Window>
  );
}

describe("the window", () => {
  test("holds the sidebar, the title bar with its toggles, the main view, the session column, the panel and a dialog", () => {
    render(frame({ dialog: <div role="dialog">settings</div> }));
    expect(screen.getByRole("button", { name: "The panels as plugins: options" })).toBeTruthy();
    expect(within(screen.getByRole("toolbar", { name: "Panels" })).getByRole("button", { name: "Terminal" })).toBeTruthy();
    for (const text of ["sidebar", "conversation", "composer", "session", "panel"]) expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toBe("settings");
  });

  test("translucent marks the frame, so the sidebar lets the window's material through", () => {
    const { container, rerender } = render(frame());
    expect(container.querySelector(".cl-window")?.hasAttribute("data-translucent")).toBe(false);
    rerender(frame({ translucent: true }));
    expect(container.querySelector(".cl-window")?.hasAttribute("data-translucent")).toBe(true);
  });

  test("the sidebar's drawn width is measured and said once laid out, then only when it changes; the safe area reaches the layout's CSS", () => {
    const said: number[] = [];
    const proto = HTMLElement.prototype as unknown as { getBoundingClientRect: () => DOMRect };
    const was = proto.getBoundingClientRect;
    let width = 247.6;
    proto.getBoundingClientRect = function (this: HTMLElement) { return { width: this.classList.contains("cl-window__sidebar") ? width : 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect; };
    try {
      const { container, rerender } = render(frame({ onSidebarWidth: (px) => said.push(px), safeArea: { left: 0, top: 0 } }));
      expect(said).toEqual([248]);
      rerender(frame({ onSidebarWidth: (px) => said.push(px), safeArea: { left: 0, top: 0 } }));
      expect(said).toEqual([248]);
      const style = (container.querySelector(".cl-window") as HTMLElement).style;
      expect([style.getPropertyValue("--cl-safe-left"), style.getPropertyValue("--cl-safe-top")]).toEqual(["0px", "0px"]);
      width = 81;
      rerender(frame({ onSidebarWidth: (px) => said.push(px) }));
      expect((container.querySelector(".cl-window") as HTMLElement).style.getPropertyValue("--cl-safe-top")).toBe("44px");
    } finally {
      proto.getBoundingClientRect = was;
    }
  });
});

/** A host that opens and closes its dialog the way the real one does. */
function Host({ cardPending, onClose }: { cardPending: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open settings
      </button>
      {frame({
        cardPending,
        dialog: open ? (
          <div role="dialog" aria-label="Settings">
            <button type="button">First</button>
            <button type="button">Last</button>
          </div>
        ) : undefined,
        onCloseDialog: () => {
          onClose?.();
          setOpen(false);
        },
      })}
    </>
  );
}

describe("no dialog over a waiting card (spec §5.5, review blocker)", () => {
  test("a dialog asked for while a card waits stays shut, and the bar says why", () => {
    const onClose = mock(() => undefined);
    render(<Host cardPending onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe("Answer the waiting card first, then open it again.");
  });

  test("a card arriving closes an open dialog through the host", () => {
    const onClose = mock(() => undefined);
    const { rerender } = render(<Host cardPending={false} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    rerender(<Host cardPending onClose={onClose} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("a host that keeps passing its dialog still never shows it over a card, and the note clears once the card is answered", () => {
    const dialog = <div role="dialog">settings</div>;
    const { rerender } = render(frame({ cardPending: true, dialog }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).not.toBe("");
    rerender(frame({ cardPending: false, dialog }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  test("the window never draws its dialog layer while a card waits", () => {
    const { container } = render(frame({ cardPending: true, dialog: <div role="dialog">settings</div> }));
    expect(container.querySelector(".cl-window__dialog")).toBeNull();
  });
});

/** A host whose dialog raises a sealed card from inside itself, as Settings does for a level change or
 *  removing a device. `cardPending` counts every card the window will draw, that one included. (The
 *  gallery test does the same with the real Settings.) */
function RaisingHost() {
  const [open, setOpen] = useState(true);
  const [card, setCard] = useState(false);
  return frame({
    cardPending: card,
    dialog: open ? (
      <div role="dialog" aria-label="Settings">
        <button type="button" onClick={() => setCard(true)}>
          Remove Laptop
        </button>
      </div>
    ) : undefined,
    onCloseDialog: () => setOpen(false),
  });
}

describe("a card raised from a dialog (review round 3, C)", () => {
  test("closes the dialog that raised it, and the bar says why", () => {
    render(<RaisingHost />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Laptop" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Answer the waiting card first, then open it again.");
  });
});

describe("the dialog layer's keyboard (review minor)", () => {
  test("focus moves in, Tab stays inside, Escape closes, and the focus goes back to the opener", () => {
    render(<Host cardPending={false} />);
    const opener = screen.getByRole("button", { name: "Open settings" });
    opener.focus();
    act(() => opener.click());
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    expect(document.activeElement).toBe(first);
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("the dialog layer's keyboard, the focus outside it", () => {
  test("Escape closes the dialog when the focus has left it (what held it went away)", async () => {
    const onClose = mock(() => undefined);
    render(<Host cardPending={false} onClose={onClose} />);
    act(() => screen.getByRole("button", { name: "Open settings" }).click());
    expect(screen.queryByRole("dialog")).not.toBeNull();
    (document.activeElement as HTMLElement | null)?.blur();
    // What the document's listeners saw, kept so that a failure says where the key went.
    const seen: string[] = [];
    const watch = (e: Event) => { seen.push(`${e.type}@${e.eventPhase}:${(e as KeyboardEvent).key}:prevented=${String(e.defaultPrevented)}`); };
    document.addEventListener("keydown", watch, true);
    document.addEventListener("keydown", watch);
    fireEvent.keyDown(document.body, { key: "Escape" });
    // On a slow runner the close lands a tick after the key (this test took 7 to 11 s there, passing on a fast one).
    try {
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 15_000 });
    } catch (e) {
      throw new Error(`the dialog stayed open; keydowns seen: ${JSON.stringify(seen)}; active: ${document.activeElement?.nodeName}; roots: ${document.body.children.length}; host onClose calls: ${onClose.mock.calls.length}; dialog still there: ${screen.queryByRole("dialog") !== null}`, { cause: e });
    } finally {
      document.removeEventListener("keydown", watch, true);
      document.removeEventListener("keydown", watch);
    }
  }, 30_000);

  test("another key on the document leaves it open", () => {
    render(<Host cardPending={false} />);
    act(() => screen.getByRole("button", { name: "Open settings" }).click());
    fireEvent.keyDown(document.body, { key: "a" });
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });
});

describe("a bot's shell skin", () => {
  const tokens = { "shell.alpha.bar": "#F3EEFFCC", "shell.alpha.bar.text": "#221A33", "shell.alpha.bar.rule": "#C9BDEB", "shell.alpha.accent": "#6A45D4", "shell.other.sidebar": "#111111", "color.text": "#000000" };

  test("skinOf reads one bot's names and nothing else", () => {
    expect(skinOf(tokens, "alpha")).toEqual({ bar: "#F3EEFFCC", "bar.text": "#221A33", "bar.rule": "#C9BDEB", accent: "#6A45D4" });
    expect(skinOf(tokens, "plain")).toBeUndefined();
  });

  test("a skin marks the groups it holds and sets their colours; without one the window is stock", () => {
    const { container, rerender } = render(frame({ skin: skinOf(tokens, "alpha") }));
    const root = container.querySelector(".cl-window") as HTMLElement;
    expect(root.getAttribute("data-skin")).toBe("bar accent");
    expect(root.style.getPropertyValue("--cl-skin-bar-text")).toBe("#221A33");
    expect(container.querySelector('.cl-skin-paint[data-for="bar"] .cl-skin-paint__layer')).not.toBeNull();
    rerender(frame({ skin: undefined }));
    expect(root.hasAttribute("data-skin")).toBe(false);
    // The paint leaves with a fade, and the sidebar keeps its content and its place.
    expect(container.querySelector(".cl-window__sidebar-content")?.textContent).toBe("sidebar");
  });

  test("a skin that still names the sidebar's old group dresses nothing of the sidebar: no mark, no colour, no paint", () => {
    const { container } = render(frame({ skin: { sidebar: "#16132B", "sidebar.text": "#FFFFFF", "sidebar.muted": "#B3A9D2", "sidebar.selected": "#2A2243", "sidebar.hover": "#201A38", accent: "#6A45D4" } }));
    const root = container.querySelector(".cl-window") as HTMLElement;
    expect(root.getAttribute("data-skin")).toBe("accent");
    expect(root.getAttribute("style") ?? "").not.toContain("sidebar");
    expect(container.querySelector('.cl-skin-paint[data-for="sidebar"]')).toBeNull();
  });

  test("the sidebar's content, the bar's title and the toggles are the same with and without a skin", () => {
    const plain = render(frame());
    const before = plain.container.querySelector(".cl-window__sidebar-content")?.innerHTML;
    plain.unmount();
    const skinned = render(frame({ skin: skinOf(tokens, "alpha") }));
    expect(skinned.container.querySelector(".cl-window__sidebar-content")?.innerHTML).toBe(before);
    expect(within(skinned.container as HTMLElement).getByRole("toolbar", { name: "Panels" })).toBeTruthy();
  });
});
