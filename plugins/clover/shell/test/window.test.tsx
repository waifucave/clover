import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { BotTab, Window, type WindowProps } from "../client/Window";

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
