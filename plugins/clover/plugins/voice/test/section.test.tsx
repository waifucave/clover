// Clover Voice's parts in the window: Settings › Voice (the modes on its own point, the choice and "Speak replies" in its
// own settings), the section of a bot's editor (the bot's voice, its own bot setting) and the stage's chip (speaking from
// the device's speech turn; its press stops or mutes).
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { fakeApi, settle } from "../../shell/runtime/testkit";
import { runtimeWith } from "../../shell/runtime/ui";
import { UiRuntimeProvider } from "../../shell/client/sdk";
import { BotVoiceSection, VoiceChip, VoiceSection } from "../client";
import type { PluginApi, PointEntry, TurnState } from "@waifucave/clover-plugin-sdk";
import type { BotRef, EntryProps } from "../../shell/runtime/types";

afterEach(cleanup);

/** The entry props a spot gives its component, for Alpha. */
const alpha = { props: { bot: { id: "alpha", name: "Alpha" } } } as unknown as EntryProps<{ bot: BotRef }>;
const ACME: PointEntry = { pluginId: "acme-voice", entryId: "acme", value: { name: "Acme Voice" } };

function mount(api: PluginApi, node: React.ReactNode) {
  render(<UiRuntimeProvider runtime={runtimeWith({ api: () => api })}>{node}</UiRuntimeProvider>);
}

/** A fake API whose settings know bots (`key@bot`). */
function api(o: { settings?: Record<string, unknown>; modes?: PointEntry[]; turn?: TurnState; calls?: { name: string; args: unknown }[] } = {}) {
  const a = fakeApi({ pluginId: "clover/voice", settings: o.settings ?? {}, points: { "clover.voice.modes": o.modes ?? [] } });
  const stored = a.stored;
  const watchers = new Set<(s: TurnState) => void>();
  return Object.assign(a, {
    settings: {
      get: async <T,>(key: string, opts?: { bot?: string }) => stored.get(opts?.bot ? `${key}@${opts.bot}` : key) as T | undefined,
      set: async (key: string, value: unknown, opts?: { bot?: string }) => void stored.set(opts?.bot ? `${key}@${opts.bot}` : key, value),
      watch: () => () => undefined,
    },
    turns: { ...a.turns, state: async () => o.turn ?? { name: "device/speech", waiting: 0 }, watch: (_n: string, l: (s: TurnState) => void) => { watchers.add(l); return () => watchers.delete(l); } },
    host: {
      call: async (name: string, args: unknown) => {
        const bot = (args as { bot?: string }).bot;
        if (name === "voiceOf") {
          const p = stored.get(`provider@${bot}`), v = stored.get(`voice@${bot}`);
          return typeof p === "string" && p !== "" && typeof v === "string" ? { provider: p, voice: v } : null;
        }
        if (name === "forget") { stored.set(`provider@${bot}`, null); stored.set(`voice@${bot}`, null); return { ok: true }; }
        o.calls?.push({ name, args });
        return { ok: true };
      },
      on: () => () => undefined,
    },
    turnWatchers: watchers,
  }) as PluginApi & { stored: Map<string, unknown>; turnWatchers: Set<(s: TurnState) => void> };
}

describe("Settings › Voice", () => {
  test("Clover Voice and the modes on its point, Clover Voice chosen while the setting is empty; a click stores the choice", async () => {
    const a = api({ modes: [ACME] });
    mount(a, <VoiceSection />);
    await act(() => settle(6));
    const group = screen.getByRole("radiogroup", { name: "Active voice" });
    const radios = () => within(group).getAllByRole("radio");
    expect(radios().map((o) => o.textContent)).toEqual(["Clover Voice", "Acme Voice"]);
    expect(radios().map((o) => o.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    await act(async () => { fireEvent.click(within(group).getByRole("radio", { name: "Acme Voice" })); await settle(4); });
    expect(a.stored.get("active")).toBe("acme-voice");
    await act(async () => { fireEvent.click(within(group).getByRole("radio", { name: "Clover Voice" })); await settle(4); });
    expect(a.stored.get("active")).toBe("");
  });

  test("a chosen voice that isn't on is shown as not running", async () => {
    mount(api({ settings: { active: "acme-voice" } }), <VoiceSection />);
    await act(() => settle(6));
    const checked = screen.getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked.map((r) => r.textContent)).toEqual(["acme-voice (not running)"]);
  });

  test("Speak replies: on while unset; the user's click writes the plugin's own speakReplies", async () => {
    const a = api();
    mount(a, <VoiceSection />);
    await act(() => settle(6));
    const sw = screen.getByRole("switch", { name: "Speak replies" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await act(async () => { fireEvent.click(sw); await settle(4); });
    expect(a.stored.get("speakReplies")).toBe(false);
    expect(screen.getByRole("switch", { name: "Speak replies" }).getAttribute("aria-checked")).toBe("false");
  });
});

describe("a bot's editor: its voice", () => {
  test("shows the bot's voice from the plugin's bot setting, and resets it to none", async () => {
    const a = api({ settings: { "provider@alpha": "fish-audio", "voice@alpha": "abc" } });
    mount(a, <BotVoiceSection {...alpha} />);
    await act(() => settle(6));
    expect(screen.getByText("abc · fish-audio")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Reset" })); await settle(4); });
    expect(screen.getByText("None")).toBeTruthy();
    expect(a.stored.get("provider@alpha")).toBeNull();
  });
});

describe("the stage's chip", () => {
  test("none for a bot with no voice", async () => {
    mount(api(), <VoiceChip {...alpha} />);
    await act(() => settle(6));
    expect(document.querySelector("button.cl-bot-stage__chip")).toBeNull();
  });

  test("mutes and unmutes; while the bot holds the device's speech turn it stops it", async () => {
    const calls: { name: string; args: unknown }[] = [];
    const a = api({ settings: { "provider@alpha": "fish-audio", "voice@alpha": "abc" }, calls });
    mount(a, <VoiceChip {...alpha} />);
    await act(() => settle(6));
    const chip = () => document.querySelector("button.cl-bot-stage__chip")!;
    expect(chip().getAttribute("data-voice")).toBe("on");
    await act(async () => { fireEvent.click(chip()); await settle(4); });
    expect(a.stored.get("speakReplies")).toBe(false);
    expect(chip().getAttribute("data-voice")).toBe("muted");
    await act(async () => { fireEvent.click(chip()); await settle(4); });
    expect(a.stored.get("speakReplies")).toBe(true);
    await act(async () => {
      for (const w of a.turnWatchers) w({ name: "device/speech", holder: { plugin: "clover/voice", note: "alpha", since: 0, until: 1 }, waiting: 0 });
      await settle(2);
    });
    expect(chip().getAttribute("data-voice")).toBe("speaking");
    await act(async () => { fireEvent.click(chip()); await settle(4); });
    expect(calls).toEqual([{ name: "stop", args: { bot: "alpha" } }]);
    // Another plugin's speech, or another bot's, isn't this bot speaking.
    await act(async () => {
      for (const w of a.turnWatchers) w({ name: "device/speech", holder: { plugin: "acme-voice", note: "alpha", since: 0, until: 1 }, waiting: 0 });
      await settle(2);
    });
    expect(chip().getAttribute("data-voice")).toBe("on");
  });
});
