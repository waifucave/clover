// The usage entries on the app's own route: no host given, the clover tree's core client (`usage.*` over the layer's
// connection) feeds them. The layer bundle binds `clover/usage` (apps/desktop/src/layer/clover), or neither draws.
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { fakeCore, settle } from "../../shell/runtime/testkit";
import { runtimeWith } from "../../shell/runtime/ui";
import { UsageSection, UsageTabEntry, coreUsageApi } from "../src/ui/host";
import { UiRuntimeProvider } from "../client/sdk";

afterEach(cleanup);

const handlers = () => ({
  "usage.summary": ((p: { groupBy: string }) => ({ groups: [{ key: p.groupBy === "source" ? "clover" : "2026-11-13", inputTokens: 900, outputTokens: 300 }] })) as never,
  "usage.plans": (() => ({ readings: [] })) as never,
  "usage.rows": (() => ({ rows: [] })) as never,
});

describe("the usage entries over the core's usage methods", () => {
  test("coreUsageApi maps rows, plans and summary onto usage.rows, usage.plans and usage.summary", async () => {
    const core = fakeCore(handlers() as never);
    const api = coreUsageApi(core);
    expect(await api.plans()).toEqual([]);
    expect(await api.summary({ from: 1, to: 2, groupBy: "source" })).toEqual([{ key: "clover", inputTokens: 900, outputTokens: 300 }]);
    expect(await api.rows({ since: 1 })).toEqual({ rows: [] });
    expect(core.calls.map((c) => c.method)).toEqual(["usage.plans", "usage.summary", "usage.rows"]);
  });

  test("with no host given, the Settings section and the island tab draw the counted tokens from the core", async () => {
    const core = fakeCore(handlers() as never);
    const runtime = runtimeWith({ core: () => core, api: () => { throw new Error("no api"); }, t: (_id, key) => key });
    const { container } = render(<UiRuntimeProvider runtime={runtime}><UsageTabEntry props={{ expanded: true }} /></UiRuntimeProvider>);
    await act(() => settle());
    expect(container.textContent ?? "").toMatch(/1\.2k tokens/);
    cleanup();
    const section = render(<UiRuntimeProvider runtime={runtime}><UsageSection props={{}} /></UiRuntimeProvider>);
    await act(() => settle());
    expect(section.container.textContent ?? "").toMatch(/900 in · 300 out/);
    expect(core.calls.some((c) => c.method === "usage.summary")).toBe(true);
  });
});
