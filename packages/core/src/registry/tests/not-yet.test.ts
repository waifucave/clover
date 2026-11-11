// Clover's own plugins this build can't run yet (`availability: { status: "not-yet" }`, the bundled tree only): listed,
// off, never started, never switched, and a home that had one on keeps its records untouched.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogPointDecl, NOT_AVAILABLE_YET } from "@waifucave/clover-plugin-sdk";
import { grantsInForce } from "../../contracts/plugin-registry";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import type { Manifest } from "../../contracts/sdk-types";
import { pluginRegistryMethods } from "../../plugin-host/registry-methods";
import { RegistryCore } from "../core";
import { openPluginRegistry } from "../open";
import { memoryRegistryStore } from "../state";

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const clover: Manifest = { manifest: 1, id: "clover", name: "Clover" } as Manifest;
// The forwarder as it was (try 11) and as it is now: the same plugin, marked.
const forwarder = (marked: boolean): Manifest => ({
  manifest: 1, name: "waifucave forwarder", engines: { clover: "^1.0.0" },
  host: { entry: "host/index.ts", runtime: "bun", start: "each" },
  capabilities: ["network:hooks.waifucave.com"],
  contributes: { "webhook.ingress": [{ id: "waifucave", name: "waifucave forwarder", handler: "ingress" }] },
  ...(marked ? { availability: { status: "not-yet", reason: "webhook-keys" } } : {}),
} as unknown as Manifest);
const tree = (marked: boolean, hash: string) => [
  { id: "clover", manifest: clover, treeHash: hash, approved: true, source: "bundled" as const },
  { id: "clover/forwarder", manifest: forwarder(marked), treeHash: hash, approved: true, source: "bundled" as const },
];

describe("a plugin not available in this build yet", () => {
  test("is listed, off with the plain reason, its entries out of every point, no capability in force", () => {
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    reg.putAll(tree(true, "sha256:2"));
    const r = reg.get("clover/forwarder")!;
    expect([r.state, r.reason, r.enabled]).toEqual(["off", NOT_AVAILABLE_YET, true]);
    expect(grantsInForce(r)).toEqual([]);
    expect(reg.entries("webhook.ingress")).toEqual([]);
    // Its parent runs as before.
    expect(reg.get("clover")!.state).toBe("running");
  });

  test("can't be switched, either way: a plain refusal, and its switch stays as it was", async () => {
    const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore() });
    reg.putAll(tree(true, "sha256:2"));
    for (const enabled of [true, false]) {
      const err = await reg.setEnabled("clover/forwarder", enabled).catch((e: Error) => e);
      expect((err as Error).message).toBe("clover/forwarder isn't available in this build yet, so it can't be turned on or off");
    }
    expect(reg.get("clover/forwarder")!.enabled).toBe(true);
  });

  test("the app's and the terminal's doors refuse it plainly: switch and restart", async () => {
    const home = mkdtempSync(join(tmpdir(), "clover-notyet-"));
    temps.push(home);
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker: new FakeApprovalBroker({ clock: new FakeClock() }), secrets: new MemorySecretStore(), settleMs: 50 });
    try {
      opened.registry.putAll(tree(true, "sha256:2"));
      const m = pluginRegistryMethods({ opened, host: { restart: async () => { throw new Error("started"); } }, home });
      for (const client of ["app", "cli"]) {
        const ctx = { caller: { kind: "user", client } } as never;
        const on = await m["plugin.setEnabled"]!({ id: "clover/forwarder", enabled: true }, ctx).catch((e: Error) => e.message);
        expect(on).toContain("isn't available in this build yet");
        const restart = await m["plugin.restart"]!({ id: "clover/forwarder" }, ctx).catch((e: Error) => e.message);
        expect(restart).toBe(`clover/forwarder isn't running (off: ${NOT_AVAILABLE_YET}), so there's nothing to restart`);
      }
    } finally {
      opened.close();
    }
  });

  test("an upgrade from a home where it was on and OK'd: listed as not available, its switch and OK kept, no card", () => {
    const store = memoryRegistryStore();
    const before = new RegistryCore({ catalog: catalogPointDecl, store });
    before.putAll(tree(false, "sha256:1"));
    // On (waiting for the point it fills, which this tree doesn't declare, or running).
    expect(["running", "waiting"]).toContain(before.get("clover/forwarder")!.state);
    expect(before.get("clover/forwarder")!.enabled).toBe(true);
    const okBefore = before.get("clover/forwarder")!.okHash;
    expect(okBefore).toBe("sha256:1");
    // The new build, on the same records.
    const after = new RegistryCore({ catalog: catalogPointDecl, store });
    after.putAll(tree(true, "sha256:2"));
    const r = after.get("clover/forwarder")!;
    expect([r.state, r.reason, r.enabled]).toEqual(["off", NOT_AVAILABLE_YET, true]);
    // Clover's own tree carries its OK to the new tree as any upgrade does: never forgotten, never asked again.
    expect(r.okHash).toBe("sha256:2");
    expect(after.okCards()).toEqual([]);
    // The records keep it on (it runs again once a build can run it).
    const kept = new RegistryCore({ catalog: catalogPointDecl, store });
    kept.putAll(tree(false, "sha256:3"));
    expect(["running", "waiting"]).toContain(kept.get("clover/forwarder")!.state);
    expect(kept.get("clover/forwarder")!.enabled).toBe(true);
  });
});
