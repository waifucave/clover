// The `computer` point end to end, against fakes (plan §4 J, M3; `cloud-support.ts` has the plugins, the fake host and
// the fake Hetzner API), and the cloud computers on a node, run by the main computer alone.
import { afterEach, describe, expect, test } from "bun:test";
import { removeTemps, tempDir } from "../../src/bots/tests/fixtures";
import { FakeClock } from "../../src/contracts/fakes/clock";
import { FakeLeaseAuthority } from "../../src/contracts/fakes/lease";
import { CloudComputers, FileCloudStateStore, type CloudCard } from "../../src/computers/cloud";
import { CloudPoint, leaseAuthority, pluginProviders, providerIds } from "../../src/computers/cloud-point";
import { Cluster } from "../tree/cluster-support";
import { cloudPlugins, PROVIDER, testUserData, TOKEN } from "./cloud-support";

afterEach(removeTemps);

async function setup(answer: (c: CloudCard) => boolean = () => true) {
  const { registry, host, hetzner, bundled, folder, clock } = await cloudPlugins();
  const cards: CloudCard[] = [];
  const authority = { canAct: () => true, tenure: () => "group:1" };
  const cloud = new CloudComputers({
    clock, store: new FileCloudStateStore(tempDir("lane-j-cloud-home-")), provider: pluginProviders(registry, host), providerIds: () => providerIds(registry),
    authority, confirm: async (c) => { cards.push(c); return answer(c); }, userData: testUserData,
  });
  const point = new CloudPoint({ registry, cloud, active: () => true });
  return { registry, folder, hetzner, cards, cloud, point, bundled };
}

describe("the computer point", () => {
  test("a cloud computer folder makes its VM through the Hetzner plugin, with the official image and the user's token", async () => {
    const { bundled, hetzner, cards, cloud, point } = await setup();
    expect(bundled.report.children.find((c) => c.folder === "provider-hetzner")?.ok).toBe(true);
    expect(await point.sync()).toMatchObject({ created: ["Cloud1"], failed: [] });
    expect(cards).toEqual([{ kind: "cloud-create", name: "Cloud1", provider: "hetzner", size: "cx22", region: "fsn1", folder: "computer-cloud1" }]);
    const [server] = [...hetzner.servers.values()];
    expect(server).toMatchObject({ name: "cloud1", server_type: "cx22", location: "fsn1", image: "ubuntu-24.04", labels: { "clover-computer": "computer-cloud1" } });
    expect(server!.user_data).toContain("169.254.169.254");
    expect(server!.user_data).not.toContain(TOKEN);
    expect(cloud.get("Cloud1")).toMatchObject({ serverId: String(server!.id), state: "created", folder: "computer-cloud1", label: "computer-cloud1" });
    // Found by its label on the next pass, through the plugin's list: nothing more is asked.
    expect(await point.sync()).toMatchObject({ created: [], adopted: [], failed: [] });
    expect(cards).toHaveLength(1);
  });

  test("a folder turned off keeps its VM unasked; a folder removed asks, and the VM goes", async () => {
    const { registry, hetzner, cards, cloud, point } = await setup();
    await point.sync();
    await registry.setEnabled("computer-cloud1", false);
    expect(await point.sync()).toMatchObject({ deleted: [], declined: [], failed: [] });
    expect(cards.map((c) => c.kind)).toEqual(["cloud-create"]);
    registry.remove("computer-cloud1");
    expect(await point.sync()).toMatchObject({ deleted: ["Cloud1"], failed: [] });
    expect(cards.at(-1)).toEqual({ kind: "cloud-delete", name: "Cloud1", provider: "hetzner", why: "folder-removed" });
    expect(hetzner.servers.size).toBe(0);
    expect(cloud.get("Cloud1")).toBeUndefined();
  });

  test("with the provider plugin off, nothing is asked and nothing is made; changes meanwhile run one sync after", async () => {
    const { registry, hetzner, cards, point } = await setup();
    await registry.setEnabled(PROVIDER, false);
    expect((await point.sync()).failed).toMatchObject([{ name: "Cloud1" }]);
    expect(cards).toEqual([]);
    await registry.setEnabled(PROVIDER, true);
    // Two changes while one sync runs: one more sync, not two.
    const first = point.sync();
    const second = point.sync();
    const third = point.sync();
    await Promise.all([first, second, third]);
    expect(cards.map((c) => c.kind)).toEqual(["cloud-create"]);
    expect(hetzner.servers.size).toBe(1);
  });
});

describe("cloud computers on a node", () => {
  test("only the lease's holder makes VMs; when the lease moves, the old holder stops", async () => {
    const cluster = new Cluster();
    const handshake = new FakeLeaseAuthority({ clock: new FakeClock() });
    const leases = { Studio: handshake.lease("d_Studio"), Laptop1: handshake.lease("d_Laptop1") };
    try {
      const made: Record<string, Awaited<ReturnType<typeof cloudPlugins>>> = {};
      const cards: string[] = [];
      for (const name of ["Studio", "Laptop1"]) made[name] = await cloudPlugins();
      const opts = {
        lease: (name: string) => leases[name as keyof typeof leases],
        cloud: (name: string) => ({
          plugins: made[name]!.registry, host: made[name]!.host, userData: testUserData,
          confirm: async (c: CloudCard) => { cards.push(`${name} ${c.kind}`); return true; },
        }),
      };
      const studio = await cluster.add("Studio", opts);
      const laptop = await cluster.add("Laptop1", opts);
      await cluster.join();
      const NONE = { created: [], adopted: [], resized: [], deleted: [], repaired: [], declined: [], failed: [], duplicates: [] };
      // Nobody holds the lease yet: nothing is asked, even when asked to sync. The registry's main flag doesn't count.
      studio.node.registry.updateSelf({ isMain: true });
      expect(await studio.node.cloud!.sync()).toEqual(NONE);
      expect(await laptop.node.cloud!.sync()).toEqual(NONE);
      expect(cards).toEqual([]);
      // Studio takes the lease: its watch starts the cloud.
      await leases.Studio.acquire();
      await studio.node.cloud!.sync();
      expect(cards).toEqual(["Studio cloud-create"]);
      expect(made.Studio!.hetzner.servers.size).toBe(1);
      expect(made.Laptop1!.hetzner.servers.size).toBe(0);
      // Studio hands the lease over: a change to its registry no longer reaches its VMs.
      await leases.Studio.release();
      await leases.Laptop1.acquire();
      made.Studio!.registry.remove("computer-cloud1");
      expect(await studio.node.cloud!.sync()).toEqual(NONE);
      expect(made.Studio!.hetzner.servers.size).toBe(1);
      // Laptop1 acts now (its fake cloud is its own here, so it has a VM to make).
      await laptop.node.cloud!.sync();
      expect(cards).toEqual(["Studio cloud-create", "Laptop1 cloud-create"]);
    } finally {
      cluster.close();
    }
  });
});
