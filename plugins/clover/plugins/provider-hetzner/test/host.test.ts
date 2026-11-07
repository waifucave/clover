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
const LABEL = "computer-cloud1";
const made = (h: FakeHetzner) => provider.create({ name: "Cloud1", size: "cx22", region: "fsn1", userData: USER_DATA, label: LABEL }, context(h));

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
    const one = await provider.create({ name: "Cloud1", size: "cx22", region: "fsn1", userData: USER_DATA, label: LABEL }, context(h, seen));
    expect(one).toEqual({ serverId: "101", address: "198.51.100.1" });
    expect(h.servers.get(101)).toMatchObject({ name: "cloud1", server_type: "cx22", location: "fsn1", image: "ubuntu-24.04", user_data: USER_DATA, labels: { "clover-computer": LABEL } });
    expect(seen.every((o) => o.auth === HETZNER_SECRET)).toBe(true);
    expect(await provider.status({ serverId: "101", label: LABEL, region: "fsn1" }, context(h))).toEqual({ state: "running", address: "198.51.100.1" });
  });

  test("resizes by turning the server off, changing its type and turning it on; deletes; a gone server says so", async () => {
    const h = new FakeHetzner(KEY);
    const ctx = context(h);
    await made(h);
    await provider.resize({ serverId: "101", label: LABEL, region: "fsn1", size: "cx32" }, { ...ctx });
    expect(h.servers.get(101)).toMatchObject({ server_type: "cx32", status: "running" });
    expect(h.requests.filter((r) => r.includes("/actions/") && !r.startsWith("GET"))).toEqual([
      "POST /v1/servers/101/actions/poweroff", "POST /v1/servers/101/actions/change_type", "POST /v1/servers/101/actions/poweron",
    ]);
    await provider.delete({ serverId: "101", label: LABEL, region: "fsn1" }, ctx);
    expect(h.servers.size).toBe(0);
    expect(await provider.status({ serverId: "101", label: LABEL, region: "fsn1" }, ctx)).toEqual({ state: "gone" });
    // Deleting what's gone already isn't an error.
    await provider.delete({ serverId: "101", label: LABEL, region: "fsn1" }, ctx);
  });

  test("Hetzner's refusals come back plainly, without the token", async () => {
    const h = new FakeHetzner("another-token");
    const err = await made(h).catch((e: Error) => e);
    expect((err as Error).message).toBe("Hetzner: unable to authenticate (unauthorized)");
    expect((err as Error).message).not.toContain(KEY);
  });

  test("lists the servers with the label, every page; acts only on a server whose label matches", async () => {
    const h = new FakeHetzner(KEY);
    const ctx = context(h);
    for (let i = 0; i < 55; i++) await provider.create({ name: `Cloud${i}`, size: "cx22", region: "fsn1", userData: USER_DATA, label: `computer-cloud${i}` }, ctx);
    // A server the user made by hand, without the label.
    h.servers.set(900, { id: 900, name: "mine", server_type: "cx22", location: "nbg1", image: "x", user_data: "", status: "running", ip: "198.51.100.200", labels: {} });
    const all = await provider.list({}, ctx);
    expect(all).toHaveLength(55);
    expect(all[0]).toEqual({ serverId: "101", label: "computer-cloud0", region: "fsn1", size: "cx22", state: "running", address: "198.51.100.1" });
    expect(await provider.list({ label: "computer-cloud7" }, ctx)).toMatchObject([{ serverId: "108", label: "computer-cloud7" }]);
    // Another computer's server, or the hand-made one, by id: refused, untouched.
    for (const a of [{ serverId: "102", label: "computer-cloud0" }, { serverId: "900", label: "computer-cloud0" }]) {
      expect(((await provider.delete({ ...a, region: "fsn1" }, ctx).catch((e: Error) => e)) as Error).message).toContain("isn't the Clover computer");
      expect(((await provider.resize({ ...a, region: "fsn1", size: "cx52" }, ctx).catch((e: Error) => e)) as Error).message).toContain("isn't the Clover computer");
    }
    expect(h.servers.get(102)!.server_type).toBe("cx22");
    expect(h.servers.has(900)).toBe(true);
    expect(((await provider.delete({ serverId: "../servers", label: LABEL, region: "fsn1" }, ctx).catch((e: Error) => e)) as Error).message).toContain("isn't a server id");
  });

  test("paired labels the server with the device's hash, keeping its other labels; only on its own server", async () => {
    const h = new FakeHetzner(KEY);
    const ctx = context(h);
    await made(h);
    const device = "a".repeat(32);
    await provider.paired({ serverId: "101", label: LABEL, region: "fsn1", device }, ctx);
    expect(h.servers.get(101)!.labels).toEqual({ "clover-computer": LABEL, "clover-device": device });
    expect((await provider.list({ label: LABEL }, ctx))[0]!.device).toBe(device);
    expect(((await provider.paired({ serverId: "101", label: "computer-other", region: "fsn1", device }, ctx).catch((e: Error) => e)) as Error).message).toContain("isn't the Clover computer");
    expect(((await provider.paired({ serverId: "101", label: LABEL, region: "fsn1", device: "device-id-itself" }, ctx).catch((e: Error) => e)) as Error).message).toContain("isn't a device label");
  });
});
