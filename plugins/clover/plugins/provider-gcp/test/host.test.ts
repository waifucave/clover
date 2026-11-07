// The provider's host half against a fake Compute Engine API: the core's keyed fetch adds the token, every change
// goes through, instances get no service account, and nothing touches the network.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateManifest } from "@waifucave/clover-plugin-sdk";
import { GCP_SECRET, provider, type ProviderContext } from "../host/index";
import { FakeCompute } from "./fake-compute";

const KEY = "test-token-not-a-secret";
const root = join(import.meta.dir, "..");
const USER_DATA = "#cloud-config\nhostname: \"cloud1\"\n";

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
    const made = await provider.create({ name: "Cloud1", size: "e2-small", region: "europe-west4-a", userData: USER_DATA }, context(c, "my-clover-123", seen));
    expect(made).toEqual({ serverId: "cloud1", address: "192.0.2.10" });
    const body = c.instances.get("cloud1")!.body;
    expect(body.serviceAccounts).toEqual([]);
    expect(body.metadata).toEqual({ items: [{ key: "user-data", value: USER_DATA }] });
    expect(c.instances.get("cloud1")!.machineType).toBe("zones/europe-west4-a/machineTypes/e2-small");
    expect(seen.every((o) => o.auth === GCP_SECRET)).toBe(true);
    expect(await provider.status({ serverId: "cloud1", region: "europe-west4-a" }, context(c))).toEqual({ state: "running", address: "192.0.2.10" });
  });

  test("resizes by stopping, setting the machine type and starting; deletes; a gone instance says so", async () => {
    const c = new FakeCompute(KEY, "my-clover-123");
    const ctx = context(c);
    await provider.create({ name: "Cloud1", size: "e2-small", region: "europe-west4-a", userData: USER_DATA }, ctx);
    await provider.resize({ serverId: "cloud1", region: "europe-west4-a", size: "e2-medium" }, ctx);
    expect(c.instances.get("cloud1")).toMatchObject({ machineType: "zones/europe-west4-a/machineTypes/e2-medium", status: "RUNNING" });
    expect(c.requests.filter((r) => r.startsWith("POST") && r.includes("/instances/"))).toEqual([
      "POST /projects/my-clover-123/zones/europe-west4-a/instances/cloud1/stop",
      "POST /projects/my-clover-123/zones/europe-west4-a/instances/cloud1/setMachineType",
      "POST /projects/my-clover-123/zones/europe-west4-a/instances/cloud1/start",
    ]);
    await provider.delete({ serverId: "cloud1", region: "europe-west4-a" }, ctx);
    expect(await provider.status({ serverId: "cloud1", region: "europe-west4-a" }, ctx)).toEqual({ state: "gone" });
    await provider.delete({ serverId: "cloud1", region: "europe-west4-a" }, ctx);
  });

  test("no project set, a bad zone, or a refusal answer plainly, without the token", async () => {
    const c = new FakeCompute(KEY, "my-clover-123");
    expect(((await provider.create({ name: "Cloud1", size: "e2-small", region: "europe-west4-a", userData: USER_DATA }, context(c, "")).catch((e: Error) => e)) as Error).message).toContain("set the project ID");
    expect(((await provider.create({ name: "Cloud1", size: "e2-small", region: "../x", userData: USER_DATA }, context(c)).catch((e: Error) => e)) as Error).message).toContain("isn't a Compute Engine zone");
    const other = new FakeCompute("another-token", "my-clover-123");
    const err = (await provider.create({ name: "Cloud1", size: "e2-small", region: "europe-west4-a", userData: USER_DATA }, context(other)).catch((e: Error) => e)) as Error;
    expect(err.message).toBe("Google Cloud: Request had invalid authentication credentials. (UNAUTHENTICATED)");
    expect(err.message).not.toContain(KEY);
  });
});
