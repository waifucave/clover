// Row 2.25: `computers.*` in a real plugin host over a real computer node (lane J's registry and holds, the cluster
// support's one computer). The card is the gate (the controller's ruling): a plugin whose OK lists `computers.control`
// ("controls the screen and input of your computers") gets every member and each answers; one with only
// `computers.read` gets the reads and is refused the control members; one with neither gets nothing; and the host-only
// members are refused from a component. Temp homes, the fake approval broker, in-memory secrets; nothing opens a window.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { Cluster } from "../../../test/tree/cluster-support";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { areasParts } from "../api/areas";
import { createApiRouter } from "../api/router";
import { startPluginHost } from "../daemon-host";

const temps: string[] = [];
let cluster: Cluster | undefined;
afterAll(() => { cluster?.close(); for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const USER: Caller = { kind: "user", client: "app" };

/** Calls one member with its arguments; answers its value, or the error's code and message, or that it is absent. */
const HOST_JS = `
const plain = (v) => (v === undefined ? "undefined" : typeof v === "function" ? "a function" : v);
export const call = async (args, ctx) => {
  const area = ctx.api.computers;
  const fn = area?.[args.member];
  if (typeof fn !== "function") return { absent: true };
  try { return { value: plain(await fn(...args.args)) }; } catch (e) { return { error: (e.code ? e.code + ": " : "") + e.message }; }
};
let heard = [];
let off;
export const watch = async (args, ctx) => { heard = []; off = ctx.api.computers.watch((c) => heard.push(c.name)); return typeof off; };
export const heardNames = async () => heard;
export const unwatch = async () => { off?.(); return true; };
`;

function plugin(home: string, id: string, capabilities: string[]): void {
  const folder = join(home, "plugins", id);
  mkdirSync(join(folder, "host"), { recursive: true });
  writeFileSync(join(folder, "clover.json"), JSON.stringify({ manifest: 1, id, name: id, version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js" }, capabilities }));
  writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(folder, "host", "index.js"), HOST_JS);
}

describe("computers.* in a real plugin host (row 2.25)", () => {
  test("with computers.control every member answers; with only computers.read the control members are refused; with neither, all; host-only members are refused from a component", async () => {
    cluster = new Cluster();
    const studio = await cluster.add("Studio");
    await cluster.join();
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-a-computers-")));
    temps.push(home);
    plugin(home, "ctl", ["computers.read", "computers.control"]);
    plugin(home, "reader", ["computers.read"]);
    plugin(home, "plain", []);
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 50 });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, fence: false, areas: { bots: () => undefined, node: () => studio.node, links: () => undefined } });
    try {
      for (const id of ["ctl", "reader", "plain"]) {
        const { card } = await opened.registry.installed(id, "app");
        const shown = broker.cards().find((c) => c.id === card)!;
        await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
        for (let i = 0; i < 200 && opened.registry.get(id)?.state === "found"; i++) await Bun.sleep(20);
      }
      expect(opened.folders.okText("ctl", "macos").lines.join(" ")).toContain("controls the screen and input of your computers");
      const call = <R>(id: string, member: string, ...args: unknown[]) => ph.host.invoke<R>({ pluginId: id, handler: "call", args: { member, args }, caller: USER });

      // With computers.control: each member, and what it answers.
      expect(await call("ctl", "list")).toEqual({ value: [expect.objectContaining({ name: "Studio" })] });
      expect(await call("ctl", "get", "Studio")).toEqual({ value: expect.objectContaining({ name: "Studio" }) });
      expect(await call("ctl", "get", "Nowhere")).toEqual({ error: expect.stringMatching(/^not_found: no computer Nowhere/) });
      const taken = await call<{ value: { held: boolean; hold: { id: string; pluginId: string } } }>("ctl", "takeHold", "Studio", { kind: "app", app: "Figma" });
      expect(taken.value).toMatchObject({ held: true, hold: { pluginId: "ctl" } });
      expect(await call("ctl", "holds", "Studio")).toEqual({ value: expect.objectContaining({ holds: [expect.objectContaining({ id: taken.value.hold.id })] }) });
      expect(await call("ctl", "takeHold", "Studio", { kind: "app", app: "Figma" })).toEqual({ value: expect.objectContaining({ held: false, reason: "held-by-other" }) });
      expect(await call("ctl", "setUserWorking", "Studio", true, { kind: "app", app: "Mail" })).toEqual({ value: "undefined" });
      expect(await call("ctl", "takeHold", "Studio", { kind: "app", app: "Mail" })).toEqual({ value: { held: false, reason: "user-working" } });
      // Only the user's message or a card answer lifts the mark.
      expect(await call("ctl", "setUserWorking", "Studio", false)).toEqual({ error: expect.stringMatching(/^refused: the user's message or their answer to a card lifts the mark/) });
      expect(await call("ctl", "setActionRunning", "Studio", true)).toEqual({ value: "undefined" });
      expect(await call("ctl", "setActionRunning", "Studio", false)).toEqual({ value: "undefined" });
      expect(await call("ctl", "cloverWindows", "Studio")).toEqual({ value: expect.any(Array) });
      expect(await call("ctl", "releaseHold", taken.value.hold.id)).toEqual({ value: "undefined" });
      expect(await call("ctl", "holds", "Studio")).toEqual({ value: expect.objectContaining({ holds: [] }) });
      expect(await ph.host.invoke({ pluginId: "ctl", handler: "watch", args: {}, caller: USER })).toBe("function");
      await ph.host.invoke({ pluginId: "ctl", handler: "unwatch", args: {}, caller: USER });

      // With only computers.read: the reads; every control member refused (absent from its API, or refused at the gate).
      expect(await call("reader", "list")).toEqual({ value: [expect.objectContaining({ name: "Studio" })] });
      expect(await call("reader", "get", "Studio")).toEqual({ value: expect.objectContaining({ name: "Studio" }) });
      for (const m of ["holds", "takeHold", "releaseHold", "setUserWorking", "setActionRunning", "cloverWindows"]) {
        const out = await call<{ absent?: true; error?: string }>("reader", m, "Studio", { kind: "app", app: "Figma" });
        expect(out.absent === true || /computers\.control/.test(out.error ?? "")).toBe(true);
      }
      // With neither: nothing.
      for (const m of ["list", "get", "watch", "holds", "takeHold", "releaseHold", "setUserWorking", "setActionRunning", "cloverWindows"]) {
        const out = await call<{ absent?: true; error?: string }>("plain", m, "Studio");
        expect(out.absent === true || /computers\.(read|control)/.test(out.error ?? "")).toBe(true);
      }
    } finally {
      await ph.close();
      opened.close();
    }

    // From a component (the plugin's UI process), through the same gate: the host-only members are refused; `holds`,
    // which components may read, answers.
    const parts = areasParts({ bots: () => undefined, node: () => studio.node, links: () => undefined });
    const granted = ["computers.read", "computers.control"];
    const router = createApiRouter({ registry: { get: (id: string) => (id === "ctl" ? ({ id, enabled: true, state: "running", granted, capabilities: granted }) as never : undefined) }, handlers: [parts.handlers] });
    const fromUi = (path: string, args: unknown[]) => router({ pluginId: "ctl", process: "ui", path, args, caller: { kind: "plugin", pluginId: "ctl" } }).then((v) => ({ value: v }), (e: Error) => ({ error: e.message }));
    for (const m of ["takeHold", "releaseHold", "setUserWorking", "setActionRunning", "cloverWindows"]) {
      expect(await fromUi(`computers.${m}`, ["Studio"])).toEqual({ error: `computers.${m} exists only in a plugin's host code` });
    }
    expect(await fromUi("computers.holds", ["Studio"])).toEqual({ value: expect.objectContaining({ holds: [] }) });
  }, 120_000);
});
