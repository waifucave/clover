// The plugin API's `computers.*` and `files.*` calls (spec §5.4, §9.2; the owner's item 88), the device list as the
// source of computers, and a peer's command let through by the user's signed answer (review N2).
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  callBindingInput, cardAnswerSigningInput, cardHashInput,
  type Card, type CardOption, type SignedCardAnswer,
} from "@waifucave/clover-protocol";
import type { CallCardRenderer } from "../../src/contracts/approval-broker";
import { isContractError } from "../../src/contracts/common";
import { MemoryAnswerLedger } from "../../src/contracts/fakes/approval-broker";
import { FakeDeviceRegistry, makeFakeDevice, toBase64 } from "../../src/contracts/fakes/device-registry";
import { computersApiRoutes, filesApiRoutes, filesWatch } from "../../src/computers/api";
import { toolCallBinding } from "../../src/tree/service";
import { Cluster, until } from "../tree/cluster-support";

let cluster: Cluster;
afterEach(() => cluster?.close());
const PLUGIN = { pluginId: "opensky", caller: { kind: "plugin" as const, pluginId: "opensky" } };
/** opensky called within a session: the router's context names it. */
const inSession = (sessionId: string) => ({ pluginId: "opensky", caller: { kind: "session" as const, sessionId, sessionKind: "bot" as const, bot: "alpha" } });
const rejection = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);

describe("computers.* for plugins", () => {
  test("the registry, and holds kept for opensky: a refused hold is an answer", async () => {
    cluster = new Cluster();
    const studio = await cluster.add("Studio");
    await cluster.add("Laptop1");
    await cluster.join();
    const api = computersApiRoutes(studio.node.registry);
    expect(((await api["computers.list"]!([], PLUGIN)) as { name: string }[]).map((c) => c.name)).toEqual(["Studio", "Laptop1"]);
    const first = (await api["computers.takeHold"]!(["Studio", { kind: "app", app: "Figma" }], inSession("s_a"))) as { held: true; hold: { id: string; session?: string } };
    expect(first.held).toBe(true);
    expect(first.hold.session).toBe("s_a");
    // The session is the router's, never one the plugin names (review minor 3).
    expect(await api["computers.takeHold"]!(["Studio", { kind: "window", app: "Figma", window: "Main" }, { session: "s_a" }], inSession("s_b"))).toEqual({ held: false, reason: "held-by-other", by: "s_a" });
    await api["computers.setUserWorking"]!(["Studio", true, { kind: "app", app: "Mail" }], PLUGIN);
    expect(await api["computers.takeHold"]!(["Studio", { kind: "app", app: "Mail" }], inSession("s_b"))).toEqual({ held: false, reason: "user-working" });
    // Only the user's message or a card answer lifts the mark.
    expect(isContractError(await rejection(api["computers.setUserWorking"]!(["Studio", false], PLUGIN)), "refused")).toBe(true);
    expect(await api["computers.holds"]!(["Studio"], PLUGIN)).toMatchObject({ userWorking: true });
    // Another plugin can't release opensky's hold.
    expect(isContractError(await rejection(api["computers.releaseHold"]!([first.hold.id], { ...PLUGIN, pluginId: "other" })), "refused")).toBe(true);
    // The same plugin outside that session (Mirror installs it everywhere) can't release a session's hold either.
    expect(isContractError(await rejection(api["computers.releaseHold"]!([first.hold.id], PLUGIN)), "refused")).toBe(true);
    expect(isContractError(await rejection(api["computers.releaseHold"]!([first.hold.id], inSession("s_b"))), "refused")).toBe(true);
    await api["computers.releaseHold"]!([first.hold.id], inSession("s_a"));
    cluster.net.partition(cluster.get("Laptop1").device);
    expect(await api["computers.takeHold"]!(["Laptop1", { kind: "app", app: "Excel" }], PLUGIN)).toEqual({ held: false, reason: "computer-offline" });
  });
});

describe("files.* for plugins: the Files panel's data", () => {
  test("list, read and watch under a folder of another computer, fenced as the plugin", async () => {
    cluster = new Cluster();
    const studio = await cluster.add("Studio");
    const laptop = await cluster.add("Laptop1");
    await cluster.join();
    mkdirSync(join(laptop.home, "proj", "src"), { recursive: true });
    writeFileSync(join(laptop.home, "proj", "src", "a.ts"), "export const a = 1;\n");
    const files = filesApiRoutes(studio.node.tree);
    const ctx = { pluginId: "clover/panel-files", caller: { kind: "plugin" as const, pluginId: "clover/panel-files" } };
    expect(((await files["files.list"]!(["home/Laptop1/proj"], ctx)) as { path: string; type: string }[]).map((e) => [e.path, e.type])).toEqual([["home/Laptop1/proj/src", "dir"]]);
    expect(await files["files.readText"]!(["home/Laptop1/proj/src/a.ts"], ctx)).toBe("export const a = 1;\n");
    expect(await files["files.readText"]!(["home/Laptop1/proj/src/a.ts", { offset: 7, length: 5 }], ctx)).toBe("const");
    expect(isContractError(await rejection(files["files.readText"]!(["home/Laptop1/.clover/run/x"], ctx)), "fenced")).toBe(true);
    const events: unknown[] = [];
    const stop = await filesWatch(studio.node.tree, ctx, "home/Laptop1/proj", (e) => events.push(e));
    await Bun.sleep(100);
    writeFileSync(join(laptop.home, "proj", "src", "b.ts"), "x");
    await until(() => JSON.stringify(events).includes("home/Laptop1/proj/src/b.ts"), 3000, "the change");
    stop();
  });
});

describe("the device list", () => {
  test("computers come from the paired devices; a revoked one leaves the tree, and an unpaired one is refused", async () => {
    const clock = { now: () => Date.now() };
    const { registry: studioDevices, device: studioKey } = await FakeDeviceRegistry.create({ clock, name: "Studio" });
    const { registry: laptopDevices, device: laptopKey } = await FakeDeviceRegistry.create({ clock, name: "Laptop1" });
    await studioDevices.add({ id: laptopKey.id, name: "Laptop1", kind: "desktop", runsCore: true, computer: "Laptop1", publicKey: laptopKey.publicKey }, { via: "terminal" });
    await laptopDevices.add({ id: studioKey.id, name: "Studio", kind: "desktop", runsCore: true, computer: "Studio", publicKey: studioKey.publicKey }, { via: "terminal" });
    const stranger = await makeFakeDevice();
    cluster = new Cluster();
    const ids = { Studio: studioKey.id, Laptop1: laptopKey.id, Stranger: stranger.id };
    const studio = await cluster.add("Studio", { deviceIds: ids, devices: (n) => (n === "Studio" ? studioDevices : laptopDevices) });
    const laptop = await cluster.add("Laptop1", { deviceIds: ids, devices: (n) => (n === "Studio" ? studioDevices : laptopDevices) });
    // On the list but not yet linked: there, and offline.
    expect(studio.node.registry.get("Laptop1")).toMatchObject({ state: "offline" });
    await cluster.join();
    expect(studio.node.registry.get("Laptop1")).toMatchObject({ state: "online" });
    // A device that isn't paired gets nothing from Laptop1's tree.
    const link = await cluster.net.endpoint(stranger.id).connect(laptop.device);
    expect(isContractError(await rejection(link.request("tree.stat", { path: "home/Laptop1" })), "refused")).toBe(true);
    await studioDevices.revoke(laptopKey.id);
    expect(studio.node.registry.get("Laptop1")).toBeUndefined();
    expect(isContractError(await rejection(studio.node.tree.stat("home/Laptop1", { as: { kind: "core" } })), "not_found")).toBe(true);
  });
});

describe("a peer's command at a level that asks", () => {
  test("runs with the user's answer signed and bound to exactly that command, once", async () => {
    if (process.platform === "win32") return;
    const clock = { now: () => Date.now() };
    const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");
    const { registry: devices } = await FakeDeviceRegistry.create({ clock, name: "Laptop1" });
    const phone = await makeFakeDevice();
    await devices.add({ id: phone.id, name: "Phone", kind: "phone", runsCore: false, publicKey: phone.publicKey }, { via: "terminal" });
    const options: CardOption[] = [{ id: "approve", kind: "approve", label: "Run" }, { id: "deny", kind: "deny", label: "Don't" }];
    const binds = (computer: string, method: string, params: unknown) => ({ computer, method, params: sha256(callBindingInput(method, params)) });
    const render: CallCardRenderer = (call) => (call.method === "tool.run" ? { kind: "tool", fields: { title: { type: "text", text: `Run on ${call.computer}` } }, options, binds: binds(call.computer, call.method, call.params) } : undefined);
    const ledger = new MemoryAnswerLedger();
    cluster = new Cluster();
    const studio = await cluster.add("Studio");
    const laptop = await cluster.add("Laptop1", { answers: (n) => (n === "Laptop1" ? { devices, ledger, render } : undefined) });
    await cluster.join();
    const input = { command: "touch made", cwd: "home/Laptop1" };
    const sign = async (bound: unknown): Promise<SignedCardAnswer> => {
      const unhashed = {
        id: `card_${Math.random().toString(36).slice(2, 12).padEnd(10, "0")}`, kind: "tool" as const, computer: "Laptop1", origin: "user" as const,
        issuedAt: clock.now(), expiresAt: null, fields: { title: { type: "text" as const, text: "Run on Laptop1" } }, options, binds: binds("Laptop1", "tool.run", bound),
      };
      const card = { ...unhashed, hash: sha256(cardHashInput(unhashed as never)) } as Card;
      const at = clock.now();
      return { card, option: "approve", device: phone.id, at, signature: toBase64(await phone.sign(new TextEncoder().encode(cardAnswerSigningInput({ id: card.id, hash: card.hash, option: "approve", at })))) };
    };
    const ctx = { session: "s_a", sessionKind: "bot" as const, callId: "c1", cwd: "home/Laptop1" };
    // An answer for another command doesn't carry this one.
    const other = await sign(toolCallBinding("Bash", { command: "rm -rf /", cwd: "home/Laptop1" }));
    const refused = await studio.node.tools.run("Bash", { command: "touch made" }, { ...ctx, answer: other });
    expect(refused.isError).toBe(true);
    const good = await sign(toolCallBinding("Bash", input));
    const ran = await studio.node.tools.run("Bash", { command: "touch made" }, { ...ctx, callId: "c2", answer: good });
    expect(ran.isError).toBe(false);
    expect(readFileSync(join(laptop.home, "made"), "utf8")).toBe("");
    // The same answer counts once.
    expect((await studio.node.tools.run("Bash", { command: "touch made" }, { ...ctx, callId: "c3", answer: good })).isError).toBe(true);
  });
});
