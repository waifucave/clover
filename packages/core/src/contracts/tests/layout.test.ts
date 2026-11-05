// Keeps the contracts a layer of their own: they import only the protocol, Node's crypto and each other, and the plugin
// SDK's types only through `sdk-types.ts`, type-only. Every contract has its fake.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as contracts from "../index";
import * as fakes from "../fakes/index";

const root = join(import.meta.dir, "..");
const sources = [
  ...readdirSync(root).filter((f) => f.endsWith(".ts")).map((f) => join(root, f)),
  ...readdirSync(join(root, "fakes")).filter((f) => f.endsWith(".ts")).map((f) => join(root, "fakes", f)),
];
const specifiers = (file: string) => [...readFileSync(file, "utf8").matchAll(/^\s*(?:import|export)[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]!);

describe("the contracts' layout", () => {
  test("they import only the protocol, node:crypto and each other", () => {
    for (const file of sources) {
      for (const spec of specifiers(file)) {
        const ok = spec === "@waifucave/clover-protocol" || spec === "node:crypto" || spec.startsWith("./") || spec.startsWith("../")
          ? !spec.includes("plugin-sdk") || file.endsWith("sdk-types.ts")
          : false;
        expect({ file: file.slice(root.length + 1), spec, ok }).toEqual({ file: file.slice(root.length + 1), spec, ok: true });
      }
    }
  });

  test("the plugin SDK is reached only through sdk-types.ts, as types", () => {
    const shim = readFileSync(join(root, "sdk-types.ts"), "utf8");
    const exports = [...shim.matchAll(/^export\s+(type\s+)?\{/gm)];
    expect(exports.length).toBeGreaterThan(0);
    for (const e of exports) expect(e[1]).toBe("type ");
    for (const file of sources.filter((f) => !f.endsWith("sdk-types.ts"))) {
      for (const line of readFileSync(file, "utf8").split("\n").filter((l) => l.includes('sdk-types"'))) expect(line).toMatch(/^import type /);
    }
  });

  test("every contract has its fake", () => {
    const expected = [
      "FakeClock", "MemorySecretStore", "FakeFence", "FakeApprovalBroker", "FakePluginRegistry", "FakePluginHost",
      "FakeSessionHost", "FakeSessionDriver", "FakeLinkNetwork", "FakeDeviceRegistry", "FakeLeaseAuthority",
      "FakeComputerRegistry", "FakeTree", "FakeAgentBackend", "FakeBrowser",
    ];
    for (const name of expected) expect(typeof (fakes as Record<string, unknown>)[name]).toBe("function");
    for (const name of ["compareStamps", "judge", "levelDecision", "acpOutcomeFor", "cardMetaOf", "crashBackoffMs", "originOf", "holdsOverlap", "splitTreePath", "deviceIdFor"]) {
      expect(typeof (contracts as Record<string, unknown>)[name]).toBe("function");
    }
  });
});
