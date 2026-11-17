// A component's watch (here `points.onMessage`, as the figure opens one per drawing) that the core refuses only for the
// page's calls-per-second cap is opened again a moment later, and then hears what comes (the SDK's layerWatch). A
// figure mounting beside a session makes many calls in its first second; its renderer's word must not be lost to that.
import { afterEach, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { usePluginApi } from "@waifucave/moss-plugin-sdk/ui";
import { emitLayerMessage, fakeCore, runtimeWith, settle, TestLayer } from "@waifucave/moss-plugin-sdk/ui/testing";
import { useEffect } from "react";

afterEach(cleanup);

const heard: unknown[] = [];
function Listener() {
  const api = usePluginApi();
  useEffect(() => api.points.onMessage("acme.beats", (m) => heard.push(m)), [api]);
  return null;
}

test("a watch refused for a busy second opens again and then hears its messages; any other refusal ends it", async () => {
  let tries = 0;
  const core = fakeCore({
    "plugin.layer.watch": (p: { call: string }) => {
      if (p.call !== "points.onMessage") throw new Error(`unexpected ${p.call}`);
      tries += 1;
      if (tries <= 2) throw new Error("acme's UI made more than 20 calls this second");
      return { watch: "w_beats" };
    },
    "plugin.layer.unwatch": () => ({}),
  });
  render(
    <TestLayer runtime={runtimeWith({ core: () => core })} pluginId="acme">
      <Listener />
    </TestLayer>,
  );
  await act(() => settle());
  expect(tries).toBe(1);
  await act(() => Bun.sleep(2_300));
  expect(tries).toBe(3);
  await act(async () => {
    emitLayerMessage({ type: "api-event", pluginId: "acme", method: "core.event", params: { type: "plugin_api_event", pluginId: "acme", watch: "w_beats", value: { from: "metronome", value: { n: 1 } } } } as never);
    await settle();
  });
  expect(heard).toEqual([{ from: "metronome", value: { n: 1 } }]);

  // Refused for any other reason, it is not opened again.
  cleanup();
  let others = 0;
  const strict = fakeCore({ "plugin.layer.watch": () => { others += 1; throw new Error("acme's OK doesn't list what points.onMessage needs"); } });
  render(
    <TestLayer runtime={runtimeWith({ core: () => strict })} pluginId="acme">
      <Listener />
    </TestLayer>,
  );
  await act(async () => { await settle(); await Bun.sleep(1_300); });
  expect(others).toBe(1);
}, 15_000);
