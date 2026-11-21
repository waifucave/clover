// A part that reads a value and then subscribes to its changes loses a change that lands between the read's answer and the
// subscription taking effect. The host takes one connection's requests in order, so a part that SUBSCRIBES FIRST and then
// reads cannot miss one: a change after the subscription is an event, a change before the read is in the read's answer.
// This makes that happen: the host handles one request, the value changes, then the host handles the next.
import { fakeApi, runtimeWith, settle, TestLayer, fakeApprovals, fakeCore } from "@waifucave/moss-plugin-sdk/ui/testing";
import type { PointEntry } from "@waifucave/moss-plugin-sdk";
import * as React from "react";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { usePoint, useSetting } from "../client/choice";

afterEach(cleanup);

/** A host that handles the part's requests (a read, a subscription) in the order they were sent, one per `step`. */
function orderedHost<V>(initial: V) {
  let value = initial;
  let subscribed = false;
  const listeners = new Set<(v: V) => void>();
  const queue: (() => void)[] = [];
  return {
    read: (): Promise<V> => new Promise((resolve) => queue.push(() => resolve(value))),
    subscribe: (l: (v: V) => void) => { queue.push(() => { subscribed = true; listeners.add(l); }); return () => { listeners.delete(l); }; },
    step: () => queue.shift()?.(),
    pending: () => queue.length,
    /** The value changes: heard only by a subscription that has taken effect. */
    change: (v: V) => { value = v; if (subscribed) for (const l of [...listeners]) l(v); },
  };
}

async function drive(host: { step(): void; pending(): number; change(v: never): void }, after: unknown, view: () => string) {
  // The host handles the part's first request, the value changes, then it handles the rest.
  await act(() => settle(4));
  host.step();
  host.change(after as never);
  await act(() => settle(4));
  while (host.pending() > 0) { host.step(); await act(() => settle(4)); }
  await act(() => settle(4));
  return view();
}

const mount = (api: unknown, child: React.ReactElement) => {
  const runtime = runtimeWith({ api: () => api as never, core: () => fakeCore({}), approvals: fakeApprovals() });
  return render(<TestLayer runtime={runtime}>{child}</TestLayer>);
};

describe("a part that reads a value and follows it ends on the latest, whenever it changes", () => {
  test("useSetting: a setting that changes after the first request is handled and before the next", async () => {
    const host = orderedHost<string>("old");
    const api = fakeApi({ pluginId: "moss/character" } as never);
    (api as unknown as { settings: unknown }).settings = { get: async () => host.read(), set: async () => undefined, watch: (_k: string, l: () => void) => host.subscribe(l) };
    function Probe() { return <p data-v={useSetting<string>("figure") ?? ""} />; }
    mount(api, <Probe />);
    const seen = await drive(host, "new", () => document.querySelector("[data-v]")!.getAttribute("data-v")!);
    expect(seen).toBe("new");
  });

  test("usePoint: an entry that appears after the first request is handled and before the next", async () => {
    const entry = (id: string): PointEntry => ({ pluginId: "p", entryId: id, value: {} });
    const host = orderedHost<PointEntry[]>([entry("old")]);
    const api = fakeApi({ pluginId: "moss/character" } as never);
    (api as unknown as { points: unknown }).points = { entries: async () => host.read(), watch: (_p: string, l: (e: PointEntry[]) => void) => host.subscribe(l) };
    function Probe() { return <p data-v={(usePoint("x") ?? []).map((e) => e.entryId).join(",")} />; }
    mount(api, <Probe />);
    const seen = await drive(host, [entry("new")], () => document.querySelector("[data-v]")!.getAttribute("data-v")!);
    expect(seen).toBe("new");
  });
});
