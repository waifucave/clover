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
});
