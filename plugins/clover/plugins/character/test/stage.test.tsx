// The character plugin's stage: it asks the `avatar` spot, keyed by the avatar file's format, for the bot's file; a bot with
// no avatar has nothing on its stage; a format nothing draws shows the portrait.
import * as React from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import type { UiEntry } from "../../shell/runtime/resolve";
import { fakeApi, fakeApprovals, fakeCore, settle } from "../../shell/runtime/testkit";
import type { BotView, EntryComponent } from "../../shell/runtime/types";
import { runtimeWith } from "../../shell/runtime/ui";
import { SPOT_DECLS } from "../../shell/runtime/catalog";
import { UiRuntimeProvider } from "../../shell/client/sdk";
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
    spot: (name) => SPOT_DECLS[name],
    entries,
    component: (_p, name) => (name === "Draw" ? Stub : undefined),
  });
  render(<UiRuntimeProvider runtime={runtime}>{React.createElement(BotStage as never, { props: { bot: { id: b.id, name: b.name } } } as never)}</UiRuntimeProvider>);
  await act(() => settle(6));
}

const renderer = (format: string): UiEntry => ({ pluginId: `x/${format}`, id: format, spot: "avatar", key: format, component: "Draw" } as UiEntry);

describe("the character stage's figure calls", () => {
  test("it reports the renderer and its declared capabilities to the core, hands the core's cue to the renderer's hub, and clears the report when it goes", async () => {
    const reports: unknown[][] = [];
    const onCue: ((v: unknown) => void)[] = [];
    const api = fakeApi({
      bots: { list: async () => [luna], get: async () => luna, watch: () => () => undefined },
      points: { "avatar.formats": [{ pluginId: "clover/vrm", entryId: "vrm", value: { format: "vrm", capabilities: ["expressions", "lookat"] } }] },
      avatar: { report: async (bot: string, report: unknown) => { reports.push([bot, report]); } },
    } as never);
    (api as { host: { on: (e: string, l: (v: unknown) => void) => () => void } }).host = { ...(api.host as object), on: (event: string, l: (v: unknown) => void) => { if (event === "clover.avatar.cue") onCue.push(l); return () => undefined; } } as never;
    const Draw: EntryComponent = () => <i data-draw />;
    const runtime = runtimeWith({ api: () => api, core: () => fakeCore({}), approvals: fakeApprovals(), spot: (name) => SPOT_DECLS[name], entries: [renderer("vrm")], component: (_p, name) => (name === "Draw" ? Draw : undefined) });
    const view = render(<UiRuntimeProvider runtime={runtime}>{React.createElement(BotStage as never, { props: { bot: { id: luna.id, name: luna.name } } } as never)}</UiRuntimeProvider>);
    await act(() => settle(6));
    expect(reports.at(-1)).toEqual(["luna", { format: "vrm", renderer: "clover/vrm", capabilities: ["expressions", "lookat"] }]);
    // The stage listens for the core's cue message for its own bot; one for another bot, or not a cue, is nothing.
    expect(onCue).toHaveLength(1);
    onCue[0]!({ bot: "luna", cue: { type: "expression", name: "happy" } });
    onCue[0]!({ bot: "someone-else", cue: { type: "expression", name: "sad" } });
    onCue[0]!({ bot: "luna", cue: { type: "dance" } });
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

  test("a bot with a voice has one small stop/mute button with a plain tooltip; a bot with none has nothing", async () => {
    await mount({ ...luna, voice: { provider: "clover/fish-audio", voice: "v1" } }, [renderer("vrm")]);
    const chip = document.querySelector(".cl-bot-stage__chip")!;
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.getAttribute("title")).toBe("Mute spoken replies");
    cleanup();
    await mount(luna, [renderer("vrm")]);
    expect(document.querySelector(".cl-bot-stage__chip")).toBeNull();
  });
});

describe("the stage's framing for a renderer in its own frame", () => {
  const style = (vars: Record<string, string>) => ({ getPropertyValue: (n: string) => vars[n] ?? "" });

  test("it reads the theme's mode, crop and headroom, each only when valid", () => {
    expect(readFraming(style({}))).toBeUndefined();
    expect(readFraming(style({ "--clover-avatar-framing": "waist", "--clover-avatar-crop": "0.56", "--clover-avatar-headroom": "0.12" }))).toEqual({ mode: "waist", crop: 0.56, headroom: 0.12 });
    // No headroom said: the default; out-of-range values are nothing.
    expect(readFraming(style({ "--clover-avatar-crop": "0.3" }))).toEqual({ crop: 0.3, headroom: 0.03 });
    expect(readFraming(style({ "--clover-avatar-crop": "0.1", "--clover-avatar-headroom": "0.9" }))).toBeUndefined();
    expect(readFraming(style({ "--clover-avatar-framing": "wide", "--clover-avatar-crop": "0.5", "--clover-avatar-headroom": "0.9" }))).toEqual({ crop: 0.5, headroom: 0.03 });
  });

  test("the avatar frame gets it as the `framing` prop, read from the stage's element, and without one it gets none", async () => {
    const sheet = document.createElement("style");
    await mount(luna, [renderer("vrm")]);
    expect(JSON.parse(document.querySelector("[data-stub]")!.textContent!)).not.toHaveProperty("framing");
    cleanup();
    sheet.textContent = ".cl-bot-stage { --clover-avatar-crop: 0.56; --clover-avatar-headroom: 0.12; }";
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
