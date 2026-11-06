// The `computer` point end to end, against fakes (plan §4 J, M3): a cloud computer folder and the Hetzner provider
// plugin, validated from their folders and held in lane B's fake registry; the provider's host half, loaded from the
// entry its manifest names, in the fake plugin host; its requests through a stand-in for the keyed fetch, which adds
// the user's token from a memory secret store; and a fake Hetzner API. No VM, no account, no network.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keyHeaderFor } from "../../../plugin-sdk/src/api/keyed-fetch";
import { catalogPointDecl } from "../../../plugin-sdk/src/catalogs/index";
import { pluginFromFolder, REPO, removeTemps, tempDir, writePlugin } from "../../src/bots/tests/fixtures";
import { ContractError } from "../../src/contracts/common";
import { FakeClock } from "../../src/contracts/fakes/clock";
import { FakePluginHost } from "../../src/contracts/fakes/plugin-host";
import { FakePluginRegistry } from "../../src/contracts/fakes/plugin-registry";
import { MemorySecretStore } from "../../src/contracts/fakes/secret-store";
import type { ApiRouter } from "../../src/contracts/plugin-host";
import type { HostModule } from "../../src/contracts/sdk-types";
import { CloudComputers, FileCloudStateStore, type CloudCard } from "../../src/computers/cloud";
import { CloudPoint, pluginProviders } from "../../src/computers/cloud-point";
import { cloudInit } from "../../src/computers/image";
import { FakeHetzner } from "../../../../plugins/clover/plugins/provider-hetzner/test/fake-hetzner";

const PROVIDER = "clover/provider-hetzner";
const TOKEN = "test-token-not-a-secret";
const SHA = "b".repeat(64);

afterEach(removeTemps);

interface AuthEntry { secret?: string; placement?: Parameters<typeof keyHeaderFor>[0] }

/** The keyed fetch's rules this test needs: the plugin's own `network:` hosts over https, and the key the auth entry
 *  names added by the core where its placement says. The plugin never sees the token. */
function keyedFetch(registry: FakePluginRegistry, secrets: MemorySecretStore, send: (url: string, init: RequestInit) => Promise<Response>): ApiRouter {
  return async ({ pluginId, path, args }) => {
    if (path !== "net.fetch") throw new ContractError("refused", `${path} isn't served in this test`);
    const [url, init = {}, opts] = args as [string, RequestInit | undefined, { auth?: string | false } | undefined];
    const manifest = registry.get(pluginId)?.manifest;
    const u = new URL(url);
    if (!manifest || u.protocol !== "https:" || !(manifest.capabilities ?? []).includes(`network:${u.host}`)) throw new ContractError("refused", `${u.host} isn't ${pluginId}'s`);
    // A `computerProviders` entry's own `auth` counts, as a model's or a voice's does.
    const entries = [...((manifest.auth ?? []) as AuthEntry[]), ...((manifest.contributes?.computerProviders ?? []).flatMap((p) => p.auth) as AuthEntry[])];
    const headers = new Headers(init.headers);
    const entry = entries.find((a) => a.secret === opts?.auth);
    if (entry) {
      const item = await secrets.get({ owner: { kind: "plugin", pluginId }, name: entry.secret! });
      if (!item) throw new ContractError("refused", "no credential");
      const placed = keyHeaderFor(entry.placement, item.value.reveal())!;
      headers.set(placed.header, placed.value);
    }
    return send(url, { ...init, headers });
  };
}

async function setup(answer: (c: CloudCard) => boolean = () => true) {
  // The bundled `clover` plugin with the Hetzner provider as its child, as the repo keeps it.
  const root = join(tempDir("lane-j-cloud-point-"), "clover");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "clover.json"), readFileSync(join(REPO, "plugins", "clover", "clover.json"), "utf8"));
  cpSync(join(REPO, "plugins", "clover", "plugins", "provider-hetzner"), join(root, "plugins", "provider-hetzner"), { recursive: true });
  const bundled = await pluginFromFolder(root, { bundled: true });
  // The user's cloud computer folder: data only.
  const folderDir = writePlugin(tempDir("lane-j-cloud-folder-"), "computer-cloud1", {
    "clover.json": { manifest: 1, id: "computer-cloud1", name: "Cloud1", contributes: { computer: { provider: "hetzner", name: "Cloud1", size: "cx22", region: "fsn1" } } },
  });
  const folder = await pluginFromFolder(folderDir);
  const registry = new FakePluginRegistry({ catalog: catalogPointDecl, plugins: [...bundled.inputs, ...folder.inputs] });
  const clock = new FakeClock();
  const host = new FakePluginHost({ clock });
  const record = registry.get(PROVIDER)!;
  host.define(PROVIDER, (await import(join(record.folder, record.manifest!.host!.entry))) as HostModule);
  const secrets = new MemorySecretStore();
  await secrets.set({ owner: { kind: "plugin", pluginId: PROVIDER }, name: "hetzner-api-token" }, TOKEN);
  const hetzner = new FakeHetzner(TOKEN);
  host.serveApi(keyedFetch(registry, secrets, hetzner.fetch));
  const cards: CloudCard[] = [];
  const cloud = new CloudComputers({
    clock, store: new FileCloudStateStore(tempDir("lane-j-cloud-home-")), provider: pluginProviders(registry, host),
    confirm: async (c) => { cards.push(c); return answer(c); },
    userData: ({ name, token }) => cloudInit({
      name, token, join: "join-ticket-for-tests",
      daemon: { url: "https://example.invalid/clover-core-linux-x64.tar.gz", sha256: SHA },
      browser: { url: "https://example.invalid/chrome-headless-shell-linux64.zip", sha256: SHA },
    }),
  });
  const point = new CloudPoint({ registry, cloud });
  return { registry, folder, hetzner, cards, cloud, point, bundled };
}

describe("the computer point", () => {
  test("a cloud computer folder makes its VM through the Hetzner plugin, with the official image and the user's token", async () => {
    const { bundled, hetzner, cards, cloud, point } = await setup();
    expect(bundled.report.children.find((c) => c.folder === "provider-hetzner")?.ok).toBe(true);
    expect(await point.sync()).toMatchObject({ created: ["Cloud1"], failed: [] });
    expect(cards).toEqual([{ kind: "cloud-create", name: "Cloud1", provider: "hetzner", size: "cx22", region: "fsn1", folder: "computer-cloud1" }]);
    const [server] = [...hetzner.servers.values()];
    expect(server).toMatchObject({ name: "cloud1", server_type: "cx22", location: "fsn1", image: "ubuntu-24.04" });
    expect(server!.user_data).toContain("169.254.169.254");
    expect(server!.user_data).not.toContain(TOKEN);
    expect(cloud.get("Cloud1")).toMatchObject({ serverId: String(server!.id), state: "creating", folder: "computer-cloud1" });
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
