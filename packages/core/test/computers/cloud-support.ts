// Cloud computers in tests (plan §4 J, M3): a cloud computer folder and the Hetzner provider plugin, validated from
// their folders and held in lane B's fake registry; the provider's host half, loaded from the entry its manifest
// names, in the fake plugin host; its requests through a stand-in for the keyed fetch, which adds the user's token
// from a memory secret store; and a fake Hetzner API. No VM, no account, no network.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keyHeaderFor } from "../../../plugin-sdk/src/api/keyed-fetch";
import { catalogPointDecl } from "../../../plugin-sdk/src/catalogs/index";
import { pluginFromFolder, REPO, tempDir, writePlugin } from "../../src/bots/tests/fixtures";
import { ContractError } from "../../src/contracts/common";
import { FakeClock } from "../../src/contracts/fakes/clock";
import { FakePluginHost } from "../../src/contracts/fakes/plugin-host";
import { FakePluginRegistry } from "../../src/contracts/fakes/plugin-registry";
import { MemorySecretStore } from "../../src/contracts/fakes/secret-store";
import type { ApiRouter } from "../../src/contracts/plugin-host";
import type { HostModule } from "../../src/contracts/sdk-types";
import { cloudInit } from "../../src/computers/image";
import { FakeHetzner } from "../../../../plugins/clover/plugins/provider-hetzner/test/fake-hetzner";

export const PROVIDER = "clover/provider-hetzner";
export const TOKEN = "test-token-not-a-secret";
const SHA = "b".repeat(64);

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

/** The plugins a cloud computer needs, on one computer: the folder, the Hetzner provider, the fake host and API. */
export async function cloudPlugins() {
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
  return { registry, host, hetzner, bundled, folder, clock };
}

/** The official image's cloud-init with test pins. */
export const testUserData = ({ name, token }: { name: string; token: string }) => cloudInit({
  name, token, join: "join-ticket-for-tests",
  daemon: { url: "https://example.invalid/clover-core-linux-x64.tar.gz", sha256: SHA },
  browser: { url: "https://example.invalid/chrome-headless-shell-linux64.zip", sha256: SHA },
});
