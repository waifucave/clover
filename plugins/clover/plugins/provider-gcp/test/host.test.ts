// The provider's host half against a fake Compute Engine API: the core's keyed fetch adds the token, every change
// goes through, instances get no service account, and nothing touches the network.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateManifest } from "@waifucave/clover-plugin-sdk";
import { GCP_SECRET, instanceName, provider, type ProviderContext } from "../host/index";
import { FakeCompute } from "./fake-compute";

const KEY = "test-token-not-a-secret";
const root = join(import.meta.dir, "..");
const USER_DATA = "#cloud-config\nhostname: \"cloud1\"\n";
const LABEL = "computer-cloud1";
const Z = "europe-west4-a";
const N = instanceName("Cloud1", LABEL);

function context(c: FakeCompute, project: string | undefined = "my-clover-123", seen: { auth?: string | false }[] = []): ProviderContext {
  return {
    api: {
      net: {
        fetch: (url, init = {}, opts = {}) => {
          seen.push(opts);
          const headers = new Headers(init.headers);
          if (opts.auth === GCP_SECRET) headers.set("authorization", `Bearer ${KEY}`);
          return c.fetch(url, { ...init, headers });
        },
      },
      settings: { get: async <T>(key: string) => (key === "project" ? (project as T | undefined) : undefined) },
    },
  };
}

describe("clover.json", () => {
  test("is valid for lane B's validator, as a bundled child of clover", () => {
    const report = validateManifest(readFileSync(join(root, "clover.json"), "utf8"), { parent: { id: "clover", namespace: "clover" }, bundled: true, folderName: "provider-gcp" });
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe("the computerProviders handler", () => {
  test("creates an instance from Ubuntu with the core's cloud-init and no service account", async () => {
    const c = new FakeCompute(KEY, "my-clover-123");
    const seen: { auth?: string | false }[] = [];
    const made = await provider.create({ name: "Cloud1", size: "e2-small", region: Z, userData: USER_DATA, label: LABEL }, context(c, "my-clover-123", seen));
    const id = c.instances.get(N)!.id;
    expect(made).toEqual({ serverId: id, address: "192.0.2.10" });
    const body = c.instances.get(N)!.body;
    expect(body.serviceAccounts).toEqual([]);
    expect(body.metadata).toEqual({ items: [{ key: "user-data", value: USER_DATA }] });
    expect(body.labels).toEqual({ "clover-computer": LABEL });
    expect(c.instances.get(N)!.machineType).toBe("zones/europe-west4-a/machineTypes/e2-small");
    expect(seen.every((o) => o.auth === GCP_SECRET)).toBe(true);
    expect(await provider.status({ serverId: id, label: LABEL, region: Z }, context(c))).toEqual({ state: "running", address: "192.0.2.10" });
    expect(await provider.list({}, context(c))).toEqual([{ serverId: id, label: LABEL, region: Z, size: "e2-small", state: "running", address: "192.0.2.10" }]);
  });

  test("resizes by stopping, setting the machine type and starting; deletes; a gone instance says so", async () => {
    const c = new FakeCompute(KEY, "my-clover-123");
    const ctx = context(c);
    const { serverId } = await provider.create({ name: "Cloud1", size: "e2-small", region: Z, userData: USER_DATA, label: LABEL }, ctx);
    await provider.resize({ serverId, label: LABEL, region: Z, size: "e2-medium" }, ctx);
    expect(c.instances.get(N)).toMatchObject({ machineType: "zones/europe-west4-a/machineTypes/e2-medium", status: "RUNNING" });
    expect(c.requests.filter((r) => r.startsWith("POST") && r.includes("/instances/"))).toEqual([
      `POST /projects/my-clover-123/zones/europe-west4-a/instances/${N}/stop`,
      `POST /projects/my-clover-123/zones/europe-west4-a/instances/${N}/setMachineType`,
      `POST /projects/my-clover-123/zones/europe-west4-a/instances/${N}/start`,
    ]);
    await provider.delete({ serverId, label: LABEL, region: Z }, ctx);
    expect(await provider.status({ serverId, label: LABEL, region: Z }, ctx)).toEqual({ state: "gone" });
    await provider.delete({ serverId, label: LABEL, region: Z }, ctx);
  });

  test("no project set, a bad zone, or a refusal answer plainly, without the token", async () => {
    const c = new FakeCompute(KEY, "my-clover-123");
    expect(((await provider.create({ name: "Cloud1", size: "e2-small", region: "europe-west4-a", userData: USER_DATA, label: LABEL }, context(c, "")).catch((e: Error) => e)) as Error).message).toContain("set the project ID");
    expect(((await provider.create({ name: "Cloud1", size: "e2-small", region: "../x", userData: USER_DATA, label: LABEL }, context(c)).catch((e: Error) => e)) as Error).message).toContain("isn't a Compute Engine zone");
    const other = new FakeCompute("another-token", "my-clover-123");
    const err = (await provider.create({ name: "Cloud1", size: "e2-small", region: Z, userData: USER_DATA, label: LABEL }, context(other)).catch((e: Error) => e)) as Error;
    expect(err.message).toBe("Google Cloud: Request had invalid authentication credentials. (UNAUTHENTICATED)");
    expect(err.message).not.toContain(KEY);
  });

  test("acts only on the instance with that id and that label, never by its name; paired clears its user-data", async () => {
    const c = new FakeCompute(KEY, "my-clover-123");
    const ctx = context(c);
    const { serverId } = await provider.create({ name: "Cloud1", size: "e2-small", region: Z, userData: USER_DATA, label: LABEL }, ctx);
    const other = c.add({ name: "cloud2", zone: Z, labels: { "clover-computer": "computer-cloud2" } });
    const mine = c.add({ name: "hand-made", zone: Z });
    expect((await provider.list({}, ctx)).map((i) => i.label).sort()).toEqual([LABEL, "computer-cloud2"]);
    expect(await provider.list({ label: "computer-cloud2" }, ctx)).toMatchObject([{ serverId: other.id }]);
    for (const id of [other.id, mine.id]) {
      expect(((await provider.delete({ serverId: id, label: LABEL, region: Z }, ctx).catch((e: Error) => e)) as Error).message).toContain("isn't the Clover computer");
      expect(((await provider.resize({ serverId: id, label: LABEL, region: Z, size: "e2-medium" }, ctx).catch((e: Error) => e)) as Error).message).toContain("isn't the Clover computer");
    }
    expect(c.instances.has("cloud2") && c.instances.has("hand-made")).toBe(true);
    // A name where the id goes is refused before any request is built.
    const before = c.requests.length;
    for (const bad of [N, "1 OR id > 0", "12345678901234567890123"]) {
      expect(((await provider.delete({ serverId: bad, label: LABEL, region: Z }, ctx).catch((e: Error) => e)) as Error).message).toContain("isn't an instance id");
    }
    expect(c.requests.length).toBe(before);
    const device = "b".repeat(32);
    await provider.paired({ serverId, label: LABEL, region: Z, device }, ctx);
    expect(c.instances.get(N)!.metadata.items).toEqual([]);
    expect(c.instances.get(N)!.labels).toEqual({ "clover-computer": LABEL, "clover-device": device });
    expect(c.requests.some((r) => r.endsWith(`/instances/${N}/setMetadata`))).toBe(true);
    expect((await provider.list({ label: LABEL }, ctx))[0]!.device).toBe(device);
  });

  test("names that fold to the same one are still two instances", async () => {
    const c = new FakeCompute(KEY, "my-clover-123");
    const ctx = context(c);
    const a = await provider.create({ name: "2Box", size: "e2-small", region: Z, userData: USER_DATA, label: "computer-2box" }, ctx);
    const b = await provider.create({ name: "Box", size: "e2-small", region: Z, userData: USER_DATA, label: "computer-box" }, ctx);
    expect(a.serverId).not.toBe(b.serverId);
    expect([...c.instances.keys()].sort()).toEqual([instanceName("2Box", "computer-2box"), instanceName("Box", "computer-box")].sort());
    expect(instanceName("2Box", "computer-2box")).toMatch(/^box-[0-9a-f]{8}$/);
    expect(instanceName("x".repeat(80), "l")).toMatch(/^[a-z]{54}-[0-9a-f]{8}$/);
  });
});
