// MOSS Code's setup guide steps aside for a card waiting in its window (the same rule as MOSS's guide): the window's
// logic (main's guideStepsAside over the router's placements) and the page's (pages.ts stepAside: the guide kept at its
// step, only not drawn). The headless harness can't put a card in MOSS Code's window (it is never in front there), so
// the in-window case is proven here.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";
import { guideStepsAside } from "../src/main/core-pages";

GlobalRegistrator.register();
const { showWelcome, stepAside } = await import("../src/core/pages");
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

type Place = { kind: string; program?: string; window?: string } | undefined;

describe("guideStepsAside", () => {
  const aside = (places: [string, Place][], pending: string[], copyWaits = false) =>
    guideStepsAside({ places, pending: (id) => pending.includes(id), program: "code", copyWaits });

  test("a pending card placed in this window (its conversation or its strip) puts the guide aside; answered, it is back", () => {
    expect(aside([], [])).toBe(false);
    expect(aside([["k1", { kind: "conversation", program: "code", window: "main" }]], ["k1"])).toBe(true);
    expect(aside([["k1", { kind: "strip", program: "code", window: "main" }]], ["k1"])).toBe(true);
    // Answered: no longer pending.
    expect(aside([["k1", { kind: "strip", program: "code", window: "main" }]], [])).toBe(false);
  });

  test("a card placed elsewhere leaves it: the island, nowhere, MOSS's window, another window", () => {
    expect(aside([["k1", { kind: "island" }]], ["k1"])).toBe(false);
    expect(aside([["k1", { kind: "elsewhere" }]], ["k1"])).toBe(false);
    expect(aside([["k1", { kind: "conversation", program: "moss", window: "main" }]], ["k1"])).toBe(false);
    expect(aside([["k1", { kind: "strip", program: "code", window: "other" }]], ["k1"])).toBe(false);
    expect(aside([["k1", undefined]], ["k1"])).toBe(false);
  });

  test("the old home's copy card waiting puts it aside too", () => {
    expect(aside([], [], true)).toBe(true);
  });
});

describe("the guide page steps aside and comes back at its step", () => {
  test("at the model step: aside while a card waits, then back, the same step and the same page", async () => {
    const host = document.createElement("div");
    host.id = "moss-page";
    document.body.append(host);
    const setup = { ready: true, missing: [], providers: ["anthropic"], default: { model: "anthropic/claude-opus-5-5", source: "chosen", effort: "medium" }, dismissed: false };
    const call = async (name: string): Promise<unknown> => {
      if (name === "welcome.providers") return { providers: [{ id: "moss/model-anthropic", name: "Anthropic", auth: [{ index: 0, method: "api-key", state: "signed-in" }] }] };
      if (name === "welcome.setup") return setup;
      if (name === "welcome.models") return { models: [{ id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic", providerName: "Anthropic" }] };
      return {};
    };
    const t = (key: string) => key;
    await showWelcome(host, t as never, call as never, () => {});
    await new Promise((r) => setTimeout(r, 20));
    (host.querySelector("[data-moss-welcome=next]") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 20));
    const section = host.querySelector("[data-moss-welcome-step=model]");
    expect(section).not.toBeNull();
    // Main's word: a card waits in this window.
    stepAside(host, true);
    expect(host.dataset.aside).toBe("yes");
    expect(host.querySelector("[data-moss-welcome-step=model]")).toBe(section);
    // Answered: back, the same page at the same step.
    stepAside(host, false);
    expect(host.dataset.aside).toBeUndefined();
    expect(host.querySelector("[data-moss-welcome-step=model]")).toBe(section);
    expect(host.querySelector("[data-moss-default]")?.getAttribute("data-moss-default")).toBe("anthropic/claude-opus-5-5");
    host.remove();
  });
});
