// MOSS Voice's part in the window: Settings › Voice ("Speak replies" in its own settings; which voice speaks is the
// platform's one-at-a-time picker, not this section's).
import { fakeApi, settle, runtimeWith, TestLayer } from "@waifucave/moss-plugin-sdk/ui/testing";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VoiceSection } from "../client";
import type { PluginApi, PointEntry, TurnState } from "@waifucave/moss-plugin-sdk";

afterEach(cleanup);

function mount(api: PluginApi, node: React.ReactNode) {
  render(<TestLayer runtime={runtimeWith({ api: () => api })}>{node}</TestLayer>);
}

/** A fake API whose settings know bots (`key@bot`). */
function api(o: { settings?: Record<string, unknown>; modes?: PointEntry[]; turn?: TurnState; calls?: { name: string; args: unknown }[]; byBot?: Record<string, unknown> } = {}) {
  const a = fakeApi({ pluginId: "moss/voice", settings: o.settings ?? {}, points: { "moss.voice.modes": o.modes ?? [] } });
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
          const off = stored.get(`silent@${bot}`) === true ? { off: true } : {};
          return typeof p === "string" && p !== "" && typeof v === "string" ? { provider: p, voice: v, from: "user", ...off } : (o.byBot?.[bot!] ?? (off.off ? off : null));
        }
        if (name === "setOff") { stored.set(`silent@${bot}`, (args as { off: boolean }).off ? true : null); return { ok: true }; }
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
  test("no voice picker of its own: which voice speaks is the platform's one-at-a-time picker", async () => {
    mount(api(), <VoiceSection />);
    await act(() => settle(6));
    expect(screen.queryByRole("radiogroup")).toBeNull();
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

