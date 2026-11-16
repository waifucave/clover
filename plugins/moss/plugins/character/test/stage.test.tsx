// The character plugin's stage: it asks the `avatar` spot, keyed by the avatar file's format, for the bot's file; a bot with
// no avatar has nothing on its stage; a format nothing draws shows the portrait.
import { type TestEntry as UiEntry, fakeApi, fakeApprovals, fakeCore, settle, runtimeWith, TestLayer } from "@waifucave/moss-plugin-sdk/ui/testing";
import type { BotView } from "@waifucave/moss-plugin-sdk";
import type { EntryComponent } from "../client/local";
import { catalogSpot } from "@waifucave/moss-plugin-sdk/ui/testing";
import { useAvatarSpeech } from "@waifucave/moss-plugin-sdk/ui";
import * as React from "react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { BotStage } from "../client";
import { readFraming } from "../client/stage";

afterEach(cleanup);

const bot = (id: string, name: string): BotView => ({ id, name, model: "m", userLayer: [], state: "idle", mainSession: `s_${id}` });
const luna: BotView = { ...bot("luna", "Luna"), portrait: "/_t/luna/p.svg", avatar: { src: "/_t/luna/a.vrm", format: "vrm" } };

async function mount(b: BotView, entries: UiEntry[]) {
  const api = fakeApi({ bots: { list: async () => [b], get: async () => b, watch: () => () => undefined } });
  const Stub: EntryComponent = ({ props }) => <div data-stub="avatar">{JSON.stringify(props)}</div>;
  const runtime = runtimeWith({
    api: () => api,
    core: () => fakeCore({}),
    approvals: fakeApprovals(),
    spot: catalogSpot,
    entries,
    component: (_p, name) => (name === "Draw" ? Stub : undefined),
  });
  render(<TestLayer runtime={runtime}>{React.createElement(BotStage as never, { props: { bot: { id: b.id, name: b.name } } } as never)}</TestLayer>);
  await act(() => settle(6));
}

const renderer = (format: string): UiEntry => ({ pluginId: `x/${format}`, id: format, spot: "avatar", key: format, component: "Draw" } as UiEntry);

describe("the character stage's figure calls", () => {
  test("it reports the renderer and its declared capabilities to the core, hands the core's cue to the renderer's hub, and clears the report when it goes", async () => {
    const reports: unknown[][] = [];
    const onCue: ((v: unknown) => void)[] = [];
    const api = fakeApi({
      bots: { list: async () => [luna], get: async () => luna, watch: () => () => undefined },
      points: { "avatar.formats": [{ pluginId: "moss/vrm", entryId: "vrm", value: { format: "vrm", capabilities: ["expressions", "lookat"] } }] },
      avatar: { report: async (bot: string, report: unknown) => { reports.push([bot, report]); } },
    } as never);
    (api as { host: { on: (e: string, l: (v: unknown) => void) => () => void } }).host = { ...(api.host as object), on: (event: string, l: (v: unknown) => void) => { if (event === "moss.avatar.cue") onCue.push(l); return () => undefined; } } as never;
    const Draw: EntryComponent = () => <i data-draw />;
    const runtime = runtimeWith({ api: () => api, core: () => fakeCore({}), approvals: fakeApprovals(), spot: catalogSpot, entries: [renderer("vrm")], component: (_p, name) => (name === "Draw" ? Draw : undefined) });
    const view = render(<TestLayer runtime={runtime}>{React.createElement(BotStage as never, { props: { bot: { id: luna.id, name: luna.name } } } as never)}</TestLayer>);
    await act(() => settle(6));
    expect(reports.at(-1)).toEqual(["luna", { format: "vrm", renderer: "moss/vrm", capabilities: ["expressions", "lookat"] }]);
    // The stage listens for the core's cue message for its own bot, once for the renderer's cues and once for its speech
    // (`useCueSpeech`); one for another bot, or not a cue, is nothing.
    expect(onCue).toHaveLength(2);
    for (const listen of onCue) {
      listen({ bot: "luna", cue: { type: "expression", name: "happy" } });
      listen({ bot: "someone-else", cue: { type: "expression", name: "sad" } });
      listen({ bot: "luna", cue: { type: "dance" } });
    }
    view.unmount();
    await act(() => settle(2));
    expect(reports.at(-1)).toEqual(["luna", undefined]);
  });
});

describe("the character stage", () => {
  test("asks the avatar spot, keyed by the file's format, for the bot's file", async () => {
    await mount(luna, [renderer("vrm")]);
    const got = JSON.parse(document.querySelector('[data-stub="avatar"]')!.textContent!);
    expect(got).toMatchObject({ src: "/_t/luna/a.vrm", file: "/_t/luna/a.vrm", format: "vrm", name: "Luna", portrait: "/_t/luna/p.svg" });
  });

  test("a renderer plugin of its own format draws a bot of that format", async () => {
    await mount({ ...luna, avatar: { src: "/_t/luna/hero.pngtuber.json", format: "pngtuber" } }, [renderer("vrm"), renderer("pngtuber")]);
    expect(JSON.parse(document.querySelector('[data-stub="avatar"]')!.textContent!)).toMatchObject({ format: "pngtuber" });
    expect(document.querySelector(".cl-bot-stage")!.getAttribute("data-format")).toBe("pngtuber");
  });

  test("a format nothing draws shows the bot's portrait", async () => {
    await mount({ ...luna, avatar: { src: "/_t/luna/a.skel", format: "spine" } }, [renderer("vrm")]);
    expect(document.querySelector('[data-stub="avatar"]')).toBeNull();
    expect(document.querySelector(".cl-bot-stage__portrait")!.getAttribute("src")).toBe("/_t/luna/p.svg");
  });

  test("a bot with no avatar has nothing on its stage", async () => {
    await mount(bot("luna", "Luna"), [renderer("vrm")]);
    expect(document.querySelector(".cl-bot-stage")).toBeNull();
  });

  test("other plugins' small controls draw on the stage (`bot.stage.action`), each given the bot", async () => {
    const control = { pluginId: "acme-voice", id: "chip", spot: "bot.stage.action", component: "Chip" } as UiEntry;
    const api = fakeApi({ bots: { list: async () => [luna], get: async () => luna, watch: () => () => undefined } });
    const Chip: EntryComponent = ({ props }) => <button type="button" data-chip={(props as { bot: { id: string } }).bot.id}>chip</button>;
    const Stub: EntryComponent = () => <div data-stub="avatar" />;
    const runtime = runtimeWith({ api: () => api, core: () => fakeCore({}), approvals: fakeApprovals(), spot: catalogSpot, entries: [renderer("vrm"), control], component: (_p, name) => (name === "Draw" ? Stub : name === "Chip" ? Chip : undefined) });
    render(<TestLayer runtime={runtime}>{React.createElement(BotStage as never, { props: { bot: { id: luna.id, name: luna.name } } } as never)}</TestLayer>);
    await act(() => settle(6));
    expect(document.querySelector(".cl-bot-stage [data-chip]")!.getAttribute("data-chip")).toBe("luna");
  });
});

describe("the stage's mouth: speech from the avatar cue API", () => {
  /** A stage whose renderer notes what the speech feed hands it, with the core's cue message under the test's hand. */
  async function stageWithMouth() {
    const heard: { at: number; frames: { t: number; rms: number; centroid: number }[]; clock: number }[] = [];
    const speaking: boolean[] = [];
    const onCue: ((v: unknown) => void)[] = [];
    const api = fakeApi({
      bots: { list: async () => [luna], get: async () => luna, watch: () => () => undefined },
      points: { "avatar.formats": [{ pluginId: "moss/vrm", entryId: "vrm", value: { format: "vrm", capabilities: ["lipsync"] } }] },
      avatar: { report: async () => undefined },
    } as never);
    (api as { host: object }).host = { ...(api.host as object), on: (event: string, l: (v: unknown) => void) => { if (event === "moss.avatar.cue") onCue.push(l); return () => undefined; } } as never;
    const Mouth: EntryComponent = () => {
      const { feed, speaking: now } = useAvatarSpeech();
      React.useEffect(() => feed?.subscribe((frames) => heard.push({ at: Date.now(), frames: [...frames], clock: feed.now() })), [feed]);
      React.useEffect(() => { speaking.push(now); }, [now]);
      return <i data-mouth />;
    };
    const runtime = runtimeWith({ api: () => api, core: () => fakeCore({}), approvals: fakeApprovals(), spot: catalogSpot, entries: [{ pluginId: "x/vrm", id: "vrm", spot: "avatar", key: "vrm", component: "Draw" } as UiEntry], component: (_p, name) => (name === "Draw" ? Mouth : undefined) });
    render(<TestLayer runtime={runtime}>{React.createElement(BotStage as never, { props: { bot: { id: luna.id, name: luna.name } } } as never)}</TestLayer>);
    await act(() => settle(6));
    // The core's message reaches every listener the stage holds, as it does in the app.
    return { heard, speaking, send: (cue: unknown, bot = "luna") => { for (const l of onCue) l({ bot, cue }); } };
  }
  const sleep = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

  test("a speech cue's levels reach the renderer as the speech feed at their stamped times, and the stage says it is speaking from the first stamp to the last", async () => {
    const m = await stageWithMouth();
    const t0 = Date.now() + 400;
    const frames = Array.from({ length: 10 }, (_, i) => ({ t: t0 + i * 20, rms: 0.4 + i / 100, centroid: 1200 }));
    m.send({ type: "speech", frames });
    await sleep(100);
    expect(m.heard).toEqual([]); // sent 400 ms ahead: not yet due, so not yet handed over
    expect(document.querySelector(".cl-bot-stage")!.getAttribute("data-speaking")).toBeNull();
    await sleep(500);
    const got = m.heard.flatMap((h) => h.frames);
    expect(got).toHaveLength(10);
    expect(got.map((f) => f.rms)).toEqual(frames.map((f) => f.rms));
    // Every level was handed over before its stamp, on the feed's clock (seconds, the stamps' differences kept).
    for (const h of m.heard) for (const f of h.frames) expect(f.t).toBeGreaterThanOrEqual(h.clock - 0.001);
    expect(got[9]!.t - got[0]!.t).toBeCloseTo(0.18, 3);
    expect(m.speaking).toEqual([false, true]);
    await sleep(400);
    expect(m.speaking).toEqual([false, true, false]);
  });

  test("a cue for another bot, a cut, and a malformed one change nothing; a cut ends the mouth", async () => {
    const m = await stageWithMouth();
    const t0 = Date.now() + 600;
    m.send({ type: "speech", frames: [{ t: t0, rms: 0.5 }] }, "someone-else");
    m.send({ type: "speech", frames: "nope" });
    m.send({ type: "speech", frames: [{ t: t0, rms: 0.5 }, { t: t0 + 20, rms: 0.5 }] });
    m.send({ type: "speech", frames: [], cut: true });
    await sleep(900);
    expect(m.heard).toEqual([]);
    expect(m.speaking).toEqual([false]);
  });

  test("the stage no longer reads the app's player: its source takes speech from the cue API only", () => {
    const source = readFileSync(new URL("../client/stage.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/useBotSpeech/);
    expect(source).toMatch(/useCueSpeech/);
    expect(source).toMatch(/"moss\.avatar\.cue"/);
  });
});

describe("the stage's framing for a renderer in its own frame", () => {
  const style = (vars: Record<string, string>) => ({ getPropertyValue: (n: string) => vars[n] ?? "" });

  test("it reads the theme's mode, crop and headroom, each only when valid", () => {
    expect(readFraming(style({}))).toBeUndefined();
    expect(readFraming(style({ "--moss-avatar-framing": "waist", "--moss-avatar-crop": "0.56", "--moss-avatar-headroom": "0.12" }))).toEqual({ mode: "waist", crop: 0.56, headroom: 0.12 });
    // No headroom said: the default; out-of-range values are nothing.
    expect(readFraming(style({ "--moss-avatar-crop": "0.3" }))).toEqual({ crop: 0.3, headroom: 0.03 });
    expect(readFraming(style({ "--moss-avatar-crop": "0.1", "--moss-avatar-headroom": "0.9" }))).toBeUndefined();
    expect(readFraming(style({ "--moss-avatar-framing": "wide", "--moss-avatar-crop": "0.5", "--moss-avatar-headroom": "0.9" }))).toEqual({ crop: 0.5, headroom: 0.03 });
  });

  test("the avatar frame gets it as the `framing` prop, read from the stage's element, and without one it gets none", async () => {
    const sheet = document.createElement("style");
    await mount(luna, [renderer("vrm")]);
    expect(JSON.parse(document.querySelector("[data-stub]")!.textContent!)).not.toHaveProperty("framing");
    cleanup();
    sheet.textContent = ".cl-bot-stage { --moss-avatar-crop: 0.56; --moss-avatar-headroom: 0.12; }";
    document.head.appendChild(sheet);
    try {
      await mount(luna, [renderer("vrm")]);
      const props = JSON.parse(document.querySelector("[data-stub]")!.textContent!);
      expect(props.framing).toEqual({ crop: 0.56, headroom: 0.12 });
    } finally {
      sheet.remove();
    }
  });
});
