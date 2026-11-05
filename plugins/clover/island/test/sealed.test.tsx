// Spec §5.5: a sealed approval frame counts as hidden under a filter, an opacity below 1, a mask, a clip or a
// transform other than a move or an enlargement, on itself or anything around it; and as covered when anything
// is painted over it, even a transparent box that ignores the pointer. A button must show whole at 24 × 24 or
// more. These hold everywhere the island puts sealed parts, at rest, checked on the real surfaces against the
// island's own stylesheet (`sealedProblems`, from the base theme's checks).

import { afterEach, describe, expect, test } from "bun:test";
import { act, fireEvent, render } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CSSProperties, ReactElement } from "react";
import { BASE_THEME, tokensFor } from "../../base-theme/src/index";
import { sealedProblems } from "../../base-theme/src/sealed-check";
import * as client from "../client/index";
import { cardGeometry } from "../src/model/geometry";
import { NEEDS_YOU, tabState } from "../src/model/tabs";
import { Island, type IslandTimers } from "../src/ui/Island";
import { LiquidCard } from "../src/ui/Liquid";
import { NeedsYou, OpenIsland } from "../src/ui/OpenIsland";
import { SealedCardContent } from "../src/ui/CardContent";
import { ISLAND_CSS } from "../src/ui/styles";
import { ISLAND_CARD_SOURCES, MIN_SEALED_BUTTON, SealedKitContext, tokenProperty, type SealedCardKit } from "../src/ui/sealed";
import { mockSealedKit } from "../src/mock-kit";
import { APPROVAL, APPROVAL_2, APPROVAL_ALWAYS, LINK, NO_NOTCH, NOTCH, QUESTION, SEALED } from "../src/fixtures";
import type { IslandCard } from "../src/model/cards";

const kit = mockSealedKit(SEALED);
const withKit = (ui: ReactElement, k: SealedCardKit = kit) => <SealedKitContext.Provider value={k}>{ui}</SealedKitContext.Provider>;

function assertVisible(container: HTMLElement): void {
  const parts = container.querySelectorAll("[data-sealed]");
  expect(parts.length).toBeGreaterThan(0);
  expect(sealedProblems(container, ISLAND_CSS)).toEqual([]);
  for (const button of container.querySelectorAll('[data-sealed="approve"], [data-sealed="deny"]')) {
    const style = (button as HTMLElement).style;
    // A glyph button is a square; one carrying its own label is at least that wide.
    expect(parseFloat(style.width || style.minWidth)).toBeGreaterThanOrEqual(MIN_SEALED_BUTTON);
    expect(parseFloat(style.height)).toBeGreaterThanOrEqual(MIN_SEALED_BUTTON);
  }
}

function clock() {
  let now = 0;
  let seq = 0;
  const timeouts = new Map<number, { at: number; fn: () => void }>();
  const frames = new Map<number, () => void>();
  const timers: IslandTimers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      timeouts.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (h) => void timeouts.delete(h as number),
    requestFrame: (fn) => {
      frames.set(++seq, fn);
      return seq;
    },
    cancelFrame: (h) => void frames.delete(h as number),
  };
  const advance = (ms: number) =>
    act(() => {
      for (let step = 0; step < ms; step += 16) {
        now += 16;
        for (const [id, t] of [...timeouts]) if (t.at <= now) (timeouts.delete(id), t.fn());
        for (const [id, fn] of [...frames]) (frames.delete(id), fn());
      }
    });
  return { timers, advance };
}

function mountIsland(cards: IslandCard[], shape = NOTCH) {
  const c = clock();
  const ui = (list: IslandCard[]) => withKit(<Island shape={shape} cards={list} timers={c.timers} />);
  const view = render(ui(cards));
  return { ...c, view, update: (list: IslandCard[]) => view.rerender(ui(list)) };
}

describe("sealed parts stay visible at rest", () => {
  const g = cardGeometry(NOTCH, { width: 400, height: 120 }, { rounded: true });

  test("on a card on top, resting and hovered", () => {
    for (const hovered of [false, true]) {
      const { container, unmount } = render(
        withKit(
          <LiquidCard geometry={g} hovered={hovered}>
            <SealedCardContent card={APPROVAL} hover={hovered ? "accept" : undefined} />
          </LiquidCard>,
        ),
      );
      assertVisible(container);
      unmount();
    }
  });

  test("an approval with an \"always\" answer: one sealed button per option, each its own, all visible", () => {
    const { container } = render(
      withKit(
        <LiquidCard geometry={g}>
          <SealedCardContent card={APPROVAL_ALWAYS} hover="accept" />
        </LiquidCard>,
      ),
    );
    assertVisible(container);
    const buttons = [...container.querySelectorAll('[data-sealed="approve"], [data-sealed="deny"]')];
    expect(buttons.map((b) => [b.getAttribute("data-option"), b.getAttribute("data-look")])).toEqual([
      ["always", "label"],
      ["deny", "cross"],
      ["once", "check"],
    ]);
    expect(buttons[0]!.textContent).toBe("Always allow");
  });

  test("but not while the card is still being born (its clicks do not count yet)", () => {
    const { container } = render(
      withKit(
        <LiquidCard geometry={g} seconds={0.7}>
          <SealedCardContent card={LINK} />
        </LiquidCard>,
      ),
    );
    expect(sealedProblems(container, ISLAND_CSS).length).toBeGreaterThan(0);
  });

  test("in the open island's Needs you, with and without a housing", () => {
    for (const shape of [NOTCH, NO_NOTCH]) {
      const { container, unmount } = render(
        withKit(
          <OpenIsland shape={shape} tabs={tabState([NEEDS_YOU])} count={3}>
            <NeedsYou cards={[APPROVAL, LINK, QUESTION, APPROVAL_2]} />
          </OpenIsland>,
        ),
      );
      assertVisible(container);
      unmount();
    }
  });

  test("on the real island: a card on top at rest, hovered, with a newcomer waiting below", () => {
    const island = mountIsland([APPROVAL]);
    island.advance(2000);
    assertVisible(island.view.container);
    fireEvent.mouseEnter(island.view.container.querySelector(".clv-card-shell")!.parentElement!.parentElement!);
    island.update([APPROVAL, LINK]);
    island.advance(400);
    expect(island.view.container.querySelector(".clv-waiting")).not.toBeNull();
    assertVisible(island.view.container);
  });

  test("on the real island: opened on Needs you, once the morph rests", () => {
    for (const shape of [NOTCH, NO_NOTCH]) {
      const island = mountIsland([APPROVAL, LINK, APPROVAL_2], shape);
      island.advance(2000);
      fireEvent.click(island.view.container.querySelector('.clv-strip [data-part="waiting"]') ?? island.view.container.querySelector(".clv-strip")!);
      island.advance(1500);
      expect(island.view.container.querySelector(".clv-open")).not.toBeNull();
      assertVisible(island.view.container);
      island.view.unmount();
    }
  });

  test("after a card goes back up into the housing, nothing of it is left over the next one", () => {
    const island = mountIsland([APPROVAL]);
    island.advance(2000);
    island.update([APPROVAL, APPROVAL_2]);
    expect(island.view.container.querySelector(".clv-returning")).not.toBeNull();
    island.advance(2000);
    expect(island.view.container.querySelector(".clv-returning")).toBeNull();
    assertVisible(island.view.container);
  });
});

describe("the check itself catches what would cover a part", () => {
  const part = '<span data-sealed="approve" style="width: 30px; height: 30px"></span>';
  const cases: [string, string][] = [
    [`<div class="shell">${part}</div>`, `.shell::after { content: ""; position: absolute; inset: 0; box-shadow: inset 0 0 0 1px #FFF; pointer-events: none }`],
    [`<div class="list">${part}</div><div class="fade"></div>`, `.fade { position: absolute; left: 0; right: 0; bottom: 0; height: 22px; pointer-events: none }`],
    [`<div class="row">${part}<span class="next"></span></div>`, `.next:hover { box-shadow: 0 0 20px #FFF }`],
    [`<div class="box" style="position: relative"><span class="badge"></span>${part}</div>`, `.badge { position: absolute; top: 0; right: 0 }`],
    [`<div class="row">${part}</div>`, `.row { opacity: 0.99 }`],
    [`<div class="row" style="filter: blur(1px)">${part}</div>`, ``],
    [`<div class="row">${part}</div>`, `.row { visibility: hidden }`],
    [`<div class="row">${part}</div><div class="top"></div>`, `.top { position: relative; z-index: 3 }`],
  ];
  for (const [html, css] of cases) {
    test(css || html, () => {
      const root = document.createElement("div");
      root.innerHTML = html;
      document.body.appendChild(root);
      expect(sealedProblems(root, css).length).toBeGreaterThan(0);
      root.remove();
    });
  }

  test("and lets through a glow beneath its row, and a rim of the box's own", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div class="row"><span class="slot">${part}</span><span class="slot after"></span></div>`;
    document.body.appendChild(root);
    const css = `.row { isolation: isolate } .slot { position: relative; box-shadow: inset 0 0 0 1px #FFF } .slot::before { content: ""; position: absolute; inset: 0; z-index: -1; box-shadow: 0 0 20px #FFF }`;
    expect(sealedProblems(root, css)).toEqual([]);
    root.remove();
  });
});

describe("the frames take the island's own tokens", () => {
  const realGetComputedStyle = globalThis.getComputedStyle;
  afterEach(() => {
    globalThis.getComputedStyle = realGetComputedStyle;
  });

  test("every card value comes from an island token, the base theme's value when nothing sets it", () => {
    const base = tokensFor(BASE_THEME, "light");
    for (const [name, source] of Object.entries(ISLAND_CARD_SOURCES)) {
      expect(name.startsWith("card.")).toBe(true);
      if ("token" in source) expect(source.fallback, name).toBe(String(base[source.token]));
    }
  });

  test("a theme's ✓ reaches the approval's frames as it reaches the question's circle", () => {
    // happy-dom resolves no custom property: read them as Chromium would, from the nearest inline style.
    globalThis.getComputedStyle = ((el: Element) => ({
      getPropertyValue: (property: string) => {
        for (let node: Element | null = el; node; node = node.parentElement) {
          const value = (node as HTMLElement).style?.getPropertyValue(property);
          if (value) return value;
        }
        return "";
      },
    })) as unknown as typeof getComputedStyle;
    const seen: Readonly<Record<string, string>>[] = [];
    const capturing: SealedCardKit = { ...kit, Card: (props) => (seen.push(props.tokens ?? {}), kit.Card(props)) };
    render(
      withKit(
        <div style={{ [tokenProperty("island.accept")]: "#1E7F47", [tokenProperty("island.accept.text")]: "#000000", [tokenProperty("island.text")]: "red; } x {" } as CSSProperties}>
          <SealedCardContent card={APPROVAL} />
        </div>,
        capturing,
      ),
    );
    const last = seen[seen.length - 1]!;
    expect(last["card.approve.background"]).toBe("#1E7F47");
    expect(last["card.approve.text"]).toBe("#000000");
    // A value that could break out of its property never reaches a frame.
    expect(last["card.text"]).toBe("#FFFFFF");
    // The question's ✓ and the approval's slot read the same token.
    expect(ISLAND_CSS).toMatch(/\.clv-circle\[data-role="accept"\],\s*\.clv-sealed-slot\[data-role="accept"\] \{\s*background: var\(--clover-island-accept,/);
  });

  test("no fixed blue anywhere in the island", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(tsx?|css)$/.test(name)) files.push(path);
      }
    };
    walk(join(import.meta.dir, "..", "src"));
    walk(join(import.meta.dir, "..", "client"));
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toMatch(/#0A85FF/i);
  });
});

describe("the client entry", () => {
  test("ships no stand-in kit", () => {
    expect("mockSealedKit" in client).toBe(false);
  });
});

describe("Needs you", () => {
  test("puts the answer line, buttons and all, before the risk and the command", () => {
    const { container } = render(withKit(<NeedsYou cards={[APPROVAL]} />));
    const card = container.querySelector("[data-sealed-card]")!;
    const order = [...card.querySelectorAll("[data-sealed]")].map((el) => el.getAttribute("data-field") ?? el.getAttribute("data-sealed"));
    expect(order).toEqual(["source", "what", "deny", "approve", "risk", "command"]);
  });
});
