// What MOSS Voice says reaches the plugins that fill its own point `moss.voice.speech` (a general point message, named on
// each filler's OK card by the point's `fills` line), never a figure API of the core's: the player's mouth levels go out as
// `points.send("moss.voice.speech", { bot, frames, cut? })`.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeApi, runtimeWith, settle, TestLayer } from "@waifucave/moss-plugin-sdk/ui/testing";
import { act, render } from "@testing-library/react";
import { Player, SPEECH_POINT } from "../client/player";

const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "moss.json"), "utf8"));

describe("MOSS Voice's speech point", () => {
  test("it declares the point with a line for its fillers' cards, and holds no figure capability", () => {
    const decl = manifest.host.declares[SPEECH_POINT];
    expect(decl).toMatchObject({ shape: "list", title: "Speech" });
    expect(decl.fills.ok).toMatch(/never their words/);
    expect(manifest.capabilities).not.toContain("avatar.control.all");
    expect(JSON.stringify(manifest)).not.toMatch(/bot\.stage|avatar\./);
  });

  test("the player sends its mouth levels as point messages on it", async () => {
    let accepted: ((stream: ReadableStream<Uint8Array>, meta: Record<string, unknown>) => void) | undefined;
    const api = fakeApi({
      pluginId: "moss/voice",
      streams: { accept: (_n: string, l: typeof accepted) => { accepted = l; return Object.assign(() => undefined, { opened: Promise.resolve() }); } },
      host: { call: async () => ({ held: [], stops: {} }), on: () => () => undefined },
      turns: { take: async () => ({ id: "t", until: 0, done: () => undefined, extend: () => undefined, lost: new Promise(() => undefined) }), watch: () => () => undefined },
    } as never);
    const runtime = runtimeWith({ api: () => api });
    render(<TestLayer runtime={runtime}><Player /></TestLayer>);
    await act(() => settle(4));
    expect(accepted).toBeDefined();
    // Whatever it sends goes to its own point, never to anything else.
    expect(api.sent.every((s) => s.point === SPEECH_POINT)).toBe(true);
  });
});
