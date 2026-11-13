// The Devices tab as another plugin's entry of the island's `island.tab` slot: its manifest, and its rows from `devices.read`.
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { settle } from "../../shell/runtime/testkit";
import { runtimeWith } from "../../shell/runtime/ui";
import manifest from "../clover.json" with { type: "json" };
import { DevicesTabEntry } from "../client/entries";
import * as client from "../client";
import { UiRuntimeProvider } from "../client/sdk";

afterEach(cleanup);

const DEVICE = { id: "d1", name: "Studio", kind: "computer", runsCore: true, online: true, isThis: true, isMain: true, addedAt: 1 };

describe("the Devices plugin", () => {
  test("is a plugin of its own that fills the island's tab slot and holds devices.read; the island holds neither", () => {
    expect(manifest.capabilities).toEqual(["devices.read"]);
    expect(manifest.contributes.ui).toEqual([{ spot: "island.tab", id: "devices", component: "DevicesTabEntry", title: "Devices", order: 900, attention: "never" }]);
    expect(typeof (client as Record<string, unknown>).DevicesTabEntry).toBe("function");
  });

  test("draws the devices it reads, and nothing without devices.read", async () => {
    const withApi = runtimeWith({ api: () => ({ devices: { list: async () => [DEVICE], watch: () => () => {} } }) as never, t: (_id, key) => key });
    const view = render(<UiRuntimeProvider runtime={withApi}><DevicesTabEntry props={{ expanded: true }} /></UiRuntimeProvider>);
    await act(() => settle());
    expect(view.container.textContent ?? "").toContain("Studio");
    cleanup();
    const without = runtimeWith({ api: () => ({}) as never, t: (_id, key) => key });
    const empty = render(<UiRuntimeProvider runtime={without}><DevicesTabEntry props={{ expanded: true }} /></UiRuntimeProvider>);
    await act(() => settle());
    expect(empty.container.innerHTML).toBe("");
  });
});
