// The provider's host half against a fake Hetzner API: the core's keyed fetch adds the token, every change goes
// through, and nothing touches the network.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateManifest } from "@waifucave/clover-plugin-sdk";
import { HETZNER_SECRET, provider, type ProviderContext } from "../host/index";
import { FakeHetzner } from "./fake-hetzner";

const KEY = "test-token-not-a-secret";
const root = join(import.meta.dir, "..");

function context(h: FakeHetzner, seen: { auth?: string | false }[] = []): ProviderContext {
  return {
    api: {
      net: {
        fetch: (url, init = {}, opts = {}) => {
          seen.push(opts);
          const headers = new Headers(init.headers);
          if (opts.auth === HETZNER_SECRET) headers.set("authorization", `Bearer ${KEY}`);
          return h.fetch(url, { ...init, headers });
        },
      },
    },
  };
}

const USER_DATA = "#cloud-config\nhostname: \"cloud1\"\n";

describe("clover.json", () => {
  test("is valid for lane B's validator, as a bundled child of clover", () => {
    const report = validateManifest(readFileSync(join(root, "clover.json"), "utf8"), { parent: { id: "clover", namespace: "clover" }, bundled: true, folderName: "provider-hetzner" });
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe("the computerProviders handler", () => {
  test("creates a server from Ubuntu with the core's cloud-init, asking the core for its token by name", async () => {
    const h = new FakeHetzner(KEY);
    const seen: { auth?: string | false }[] = [];
    const made = await provider.create({ name: "Cloud1", size: "cx22", region: "fsn1", userData: USER_DATA }, context(h, seen));
    expect(made).toEqual({ serverId: "101", address: "198.51.100.1" });
    expect(h.servers.get(101)).toMatchObject({ name: "cloud1", server_type: "cx22", location: "fsn1", image: "ubuntu-24.04", user_data: USER_DATA });
    expect(seen.every((o) => o.auth === HETZNER_SECRET)).toBe(true);
    expect(await provider.status({ serverId: "101", region: "fsn1" }, context(h))).toEqual({ state: "running", address: "198.51.100.1" });
  });

  test("resizes by turning the server off, changing its type and turning it on; deletes; a gone server says so", async () => {
    const h = new FakeHetzner(KEY);
    const ctx = context(h);
    await provider.create({ name: "Cloud1", size: "cx22", region: "fsn1", userData: USER_DATA }, ctx);
    await provider.resize({ serverId: "101", region: "fsn1", size: "cx32" }, { ...ctx });
    expect(h.servers.get(101)).toMatchObject({ server_type: "cx32", status: "running" });
    expect(h.requests.filter((r) => r.includes("/actions/") && !r.startsWith("GET"))).toEqual([
      "POST /v1/servers/101/actions/poweroff", "POST /v1/servers/101/actions/change_type", "POST /v1/servers/101/actions/poweron",
    ]);
    await provider.delete({ serverId: "101", region: "fsn1" }, ctx);
    expect(h.servers.size).toBe(0);
    expect(await provider.status({ serverId: "101", region: "fsn1" }, ctx)).toEqual({ state: "gone" });
    // Deleting what's gone already isn't an error.
    await provider.delete({ serverId: "101", region: "fsn1" }, ctx);
  });

  test("Hetzner's refusals come back plainly, without the token", async () => {
    const h = new FakeHetzner("another-token");
    const err = await provider.create({ name: "Cloud1", size: "cx22", region: "fsn1", userData: USER_DATA }, context(h)).catch((e: Error) => e);
    expect((err as Error).message).toBe("Hetzner: unable to authenticate (unauthorized)");
    expect((err as Error).message).not.toContain(KEY);
  });
});
