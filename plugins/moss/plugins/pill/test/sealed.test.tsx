// Spec §5.5: a sealed approval frame counts as hidden under a filter, an opacity below 1, a mask, a clip or a
// transform other than a move or an enlargement, on itself or anything around it; and as covered when anything
// is painted over it, even a transparent box that ignores the pointer. A button must show whole at 24 × 24 or
// more. These hold wherever the pill puts sealed parts, at rest, checked on the real pill against its own
// stylesheet (`sealedProblems`, the SDK's theme lint).

import { afterEach, describe, expect, test } from "bun:test";
import { act, fireEvent, render } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CSSProperties, ReactElement } from "react";
import { resolveTokens } from "@waifucave/moss-plugin-sdk";
import { sealedProblems } from "@waifucave/moss-plugin-sdk/ui/testing";
import * as client from "../client/index";
import { CardBody } from "../src/ui/Card";
import { DispatchPill, type DispatchPillProps } from "../src/ui/DispatchPill";
import type { FrameTimers } from "../src/ui/Plume";
import { Shell } from "../src/ui/Shell";
import { PILL_CSS } from "../src/ui/styles";
import { MIN_SEALED_BUTTON, PILL_CARD_SOURCES, resolveCardTokens, SealedKitContext, tokenProperty, type SealedCardKit } from "../src/ui/sealed";
import { mockSealedKit } from "../src/mock-kit";
import { PILL_STORIES as STORIES } from "../src/gallery";
import { emptyDraft } from "../src/model/cards";
import { AGENTS, ALPHA, APPROVAL, APPROVAL_ALWAYS, LINK, SEALED, TARGETS } from "../src/fixtures";

const kit = mockSealedKit(SEALED);
const withKit = (ui: ReactElement, k: SealedCardKit = kit) => <SealedKitContext.Provider value={k}>{ui}</SealedKitContext.Provider>;

function assertVisible(container: HTMLElement): void {
  expect(container.querySelectorAll("[data-sealed]").length).toBeGreaterThan(0);
  expect(sealedProblems(container, PILL_CSS)).toEqual([]);
  for (const button of container.querySelectorAll('[data-sealed="approve"], [data-sealed="deny"]')) {
    const style = (button as HTMLElement).style;
    // A glyph button is a square; one carrying its own label is at least that wide.
    expect(parseFloat(style.width || style.minWidth)).toBeGreaterThanOrEqual(MIN_SEALED_BUTTON);
    expect(parseFloat(style.height)).toBeGreaterThanOrEqual(MIN_SEALED_BUTTON);
  }
}

function frames() {
  let now = 1000;
  let seq = 0;
  const pending = new Map<number, (time: number) => void>();
  const timers: FrameTimers = {
    now: () => now,
    requestFrame: (fn) => {
      pending.set(++seq, fn);
      return seq;
    },
    cancelFrame: (id) => void pending.delete(id),
  };
  const run = (ms: number) => {
    const end = now + ms;
    while (now < end) {
      act(() => {
        now = Math.min(end, now + 16);
        for (const [id, fn] of [...pending]) (pending.delete(id), fn(now));
      });
    }
  };
  return { timers, run, get pending() { return pending.size; } };
}

function mountPill(props: Partial<DispatchPillProps>) {
  const clock = frames();
  const view = render(withKit(<DispatchPill target={ALPHA} targets={TARGETS} timers={clock.timers} {...props} />));
  return { ...view, clock };
}


/** What may not happen to a container of a sealed frame while the user can press: no transform, opacity below 1 or filter on it, whether inline or from a
 *  hover / focus / press rule, and no transition of those. A sealed button read (IntersectionObserver v2) while its container moves, fades or filters
 *  says "not visible", and the press is refused. Paint-only cues (a rim, a shadow, a background) are fine. */
function motionProblems(container: HTMLElement, css: string): string[] {
  const problems: string[] = [];
  const ancestors = new Set<HTMLElement>();
  for (const part of container.querySelectorAll("[data-sealed]")) {
    for (let el = part.parentElement; el !== null && el !== container.parentElement; el = el.parentElement) ancestors.add(el);
  }
  const classes = new Set<string>();
  for (const el of ancestors) {
    for (const c of Array.from(el.classList)) classes.add(c);
    const st = el.style;
    if (st.transform !== "" && st.transform !== "none") problems.push(`an ancestor (${el.className}) has an inline transform ${st.transform}`);
    if (st.filter !== "" && st.filter !== "none") problems.push(`an ancestor (${el.className}) has an inline filter ${st.filter}`);
    if (st.opacity !== "" && Number(st.opacity) < 1) problems.push(`an ancestor (${el.className}) has an inline opacity ${st.opacity}`);
    if (/transform|opacity|filter|all/.test(st.transition)) problems.push(`an ancestor (${el.className}) has an inline transition of ${st.transition}`);
  }
  const subjectOf = (selector: string): string[] => {
    const last = selector.trim().split(/\s+|>|\+|~/).filter(Boolean).pop() ?? "";
    return [...last.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
  };
  for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selectors, body] = rule;
    for (const selector of selectors!.split(",")) {
      if (!subjectOf(selector).some((c) => classes.has(c))) continue;
      const state = /:hover|:focus|:active|\[data-hovered|\[data-pressed/.test(selector);
      if (state && /(^|[;\s])(transform|translate|scale|rotate|filter|opacity)\s*:/.test(body!)) problems.push(`${selector.trim()} sets a transform, filter or opacity on a state of a sealed frame's container`);
      if (/(^|[;\s])transition(-property)?\s*:[^;]*(transform|opacity|filter|\ball\b)/.test(body!)) problems.push(`${selector.trim()} transitions a transform, filter or opacity on a sealed frame's container`);
    }
  }
  return problems;
}

describe("sealed parts stay visible at rest, on the real pill", () => {
  test("an approval, one with an \"always\" answer, and a link request on top, once the shape rests", () => {
    for (const card of [APPROVAL, APPROVAL_ALWAYS, LINK]) {
      const pill = mountPill({ cards: [card] });
      pill.clock.run(2500);
      expect(pill.clock.pending).toBe(0);
      assertVisible(pill.container);
      pill.unmount();
    }
  });

  test("under the pointer (the whole stack grows), with agents above it and the plume running", () => {
    const pill = mountPill({ cards: [APPROVAL, LINK], agents: AGENTS, running: true });
    pill.clock.run(2500);
    fireEvent.mouseEnter(pill.container.querySelector(".clp-stage")!);
    pill.clock.run(600);
    assertVisible(pill.container);
  });

  test("under the pointer, nothing around a sealed frame is moved, scaled, faded or filtered, nor transitioned (a reading taken while it moves says \"not visible\")", () => {
    const pill = mountPill({ cards: [APPROVAL, LINK], agents: AGENTS, running: true });
    pill.clock.run(2500);
    fireEvent.mouseEnter(pill.container.querySelector(".clp-stage")!);
    pill.clock.run(600);
    expect(pill.container.querySelector(".clp-stage[data-hovered]")).not.toBeNull();
    expect(motionProblems(pill.container, PILL_CSS)).toEqual([]);
  });

  test("the check itself catches a hover scale on the stack and a transition of a transform", () => {
    const pill = mountPill({ cards: [APPROVAL] });
    pill.clock.run(2500);
    expect(motionProblems(pill.container, ".clp-stage[data-hovered] .clp-stack { transform: scale(1.03) }")).toHaveLength(1);
    expect(motionProblems(pill.container, ".clp-stack { transition: transform 300ms linear(0, 1) }")).toHaveLength(1);
    expect(motionProblems(pill.container, ".clp-shell { transition: box-shadow 150ms ease-out }")).toEqual([]);
  });

  test("but not while the shape still moves or the card fades (its clicks do not count yet)", () => {
    const moving = render(
      withKit(
        <Shell size={{ width: 380, height: 100 }} target={{ width: 440, height: 180 }}>
          <CardBody card={APPROVAL} draft={emptyDraft()} />
        </Shell>,
      ),
    );
    expect(sealedProblems(moving.container, PILL_CSS).length).toBeGreaterThan(0);
    moving.unmount();
    const fading = render(
      withKit(
        <Shell size={{ width: 440, height: 180 }} target={{ width: 440, height: 180 }} visibility={0.5}>
          <CardBody card={APPROVAL} draft={emptyDraft()} />
        </Shell>,
      ),
    );
    expect(sealedProblems(fading.container, PILL_CSS).length).toBeGreaterThan(0);
  });
});

describe("the sealed buttons", () => {
  test("one per option, each its own: the \"always\" answer on its label, then ✕, then ✓", () => {
    const { container } = render(withKit(<CardBody card={APPROVAL_ALWAYS} draft={emptyDraft()} />));
    const buttons = [...container.querySelectorAll('[data-sealed="approve"], [data-sealed="deny"]')];
    expect(buttons.map((b) => [b.getAttribute("data-option"), b.getAttribute("data-look")])).toEqual([
      ["always", "label"],
      ["deny", "cross"],
      ["once", "check"],
    ]);
  });

  test("a field the card lacks leaves no empty box, and the buttons still show whole", () => {
    // A web fetch asks with no command: the kit draws nothing for it (lane B's rule), so no grey slab shows.
    const { container } = render(withKit(<CardBody card={APPROVAL_ALWAYS} draft={emptyDraft()} />));
    expect(container.querySelector('[data-field="command"]')).toBeNull();
    expect(container.querySelector('[data-field="what"]')?.textContent).toBe("Read pages on wikipedia.org");
    assertVisible(container);
  });

  test("a card that lists no options gets the first of each kind", () => {
    const { container } = render(withKit(<CardBody card={LINK} draft={emptyDraft()} />));
    const buttons = [...container.querySelectorAll('[data-sealed="approve"], [data-sealed="deny"]')];
    expect(buttons.map((b) => [b.getAttribute("data-option"), b.getAttribute("data-look")])).toEqual([
      [null, "cross"],
      [null, "open"],
    ]);
  });
});

describe("the frames take the pill's own tokens", () => {
  const realGetComputedStyle = globalThis.getComputedStyle;
  afterEach(() => {
    globalThis.getComputedStyle = realGetComputedStyle;
  });

  test("every card value comes from a pill token, the base theme's value when nothing sets it", () => {
    const base = resolveTokens("light", []);
    for (const [name, source] of Object.entries(PILL_CARD_SOURCES)) {
      expect(name.startsWith("card.")).toBe(true);
      if ("token" in source) expect(source.fallback, name).toBe(String(base[source.token]));
    }
  });

  test("card styling (G-M3): the frames get every card token, the theme's face, the ✓'s own ink, and never a keyword", () => {
    const { CARD_TOKENS } = require("../../../../../packages/plugin-sdk/src/catalogs/tokens") as { CARD_TOKENS: readonly { name: string }[] };
    expect(Object.keys(PILL_CARD_SOURCES).sort()).toEqual(CARD_TOKENS.map((x) => x.name).sort());
    const src = PILL_CARD_SOURCES["card.approve.text"]!;
    expect("token" in src && src.token).toBe("pill.accept.text");
    const font = PILL_CARD_SOURCES["card.font.family"]!;
    expect("token" in font && font.token).toBe("card.font.family");
    const unresolved = resolveCardTokens(PILL_CARD_SOURCES, () => "system");
    for (const [key, source] of Object.entries(PILL_CARD_SOURCES)) if ("token" in source) expect(unresolved[key], key).toBe(source.fallback);
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
        <div style={{ [tokenProperty("pill.accept")]: "#1E7F47", [tokenProperty("pill.text")]: "url(https://evil.test/x)" } as CSSProperties}>
          <CardBody card={APPROVAL} draft={emptyDraft()} />
        </div>,
        capturing,
      ),
    );
    const last = seen[seen.length - 1]!;
    expect(last["card.approve.background"]).toBe("#1E7F47");
    // A value that could load something never reaches a frame.
    expect(last["card.approve.text"]).toBe("#FFFFFF");
    // The question's ✓ and the approval's slot read the same token.
    expect(PILL_CSS).toMatch(/\.clp-answer\[data-role="accept"\] \{[^}]*background: var\(--moss-pill-accept,/);
    expect(PILL_CSS).toMatch(/\.clp-slot\[data-role="accept"\] \{[^}]*background: var\(--moss-pill-accept,/);
  });

  test("no fixed blue anywhere in the pill", () => {
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

describe("the gallery's stories", () => {
  test("each records every sealed part it draws, so the Chromium check counts them all (none skipped)", () => {
    for (const story of STORIES) {
      const view = render(<>{story.render()}</>);
      const drawn = view.container.querySelectorAll("[data-sealed]").length;
      const recorded = (story.sealed?.visible ?? 0) + (story.sealed?.moving ?? 0) + (story.sealed?.scrolled ?? 0);
      expect(recorded, story.id).toBe(drawn);
      view.unmount();
    }
  });
});
