// Spike S4 as the core sees it (spec §6.6): the Fish Audio plugin (`plugins/clover/fish-audio`) validates as a child of
// the bundled `clover` plugin, its `voices` entry comes up in the registry, and its host half, loaded from the entry its
// manifest names, runs in lane B's fake plugin host, which is how the core runs it until B-M2. Every request it makes
// goes through the plugin API's keyed fetch: here a stand-in that keeps the door's first two rules, the plugin's own
// `network:` hosts over https, and the key added by the core from the secret store where the `auth` entry's placement
// says (`keyHeaderFor`), revealed into that header and nowhere else, with any header echoing it taken out of the
// response (`stripEchoedKey`). Lane A's reference fetch takes its place at B-M2. Fish is the recorded fake the plugin's
// own tests use. No network, no account, no key. The `voices` point itself, and a bot speaking, are M3.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keyHeaderFor, stripEchoedKey } from "../../../../plugin-sdk/src/api/keyed-fetch";
import { KEYED_FETCH_ERROR_CODES, type KeyedFetchErrorCode, type KeyedFetchOptions } from "../../../../plugin-sdk/src/api/plugin-api";
import { pluginFromFolder, REPO, removeTemps, tempDir } from "../../bots/tests/fixtures";
import { ContractError } from "../../contracts/common";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakePluginHost } from "../../contracts/fakes/plugin-host";
import { FakePluginRegistry } from "../../contracts/fakes/plugin-registry";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import type { ApiRouter } from "../../contracts/plugin-host";
import type { PluginRecord } from "../../contracts/plugin-registry";
import type { SecretStore } from "../../contracts/secret-store";
import type { HostModule, Manifest } from "../../contracts/sdk-types";
import type { ListenResult, SpeakResult } from "../../../../../plugins/clover/fish-audio/host/index";
import { FakeFish } from "../../../../../plugins/clover/fish-audio/test/fake-fish";

const PLUGIN = "clover/fish-audio";
const KEY = "test-key-not-a-secret";
const VOICE = "1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f";
const KEY_REF = { owner: { kind: "plugin" as const, pluginId: PLUGIN }, name: "fish-api-key" };

afterEach(removeTemps);

/** Lane A's failure, as the plugin sees it: a closed code, never a key or a body. */
class KeyedFetchError extends Error {
  constructor(readonly code: KeyedFetchErrorCode, message: string) {
    super(message);
    this.name = "KeyedFetchError";
  }
}

interface Asked {
  url: string;
  opts: KeyedFetchOptions | undefined;
  /** The plugin set an `Authorization` header of its own. */
  ownHeader: boolean;
}

type KeyedAuth = Extract<NonNullable<Manifest["auth"]>[number], { secret: string }>;

/** The plugin API this test serves: `net.fetch` alone, keeping the keyed fetch's first two rules (plugin API, §5.4). */
function servePluginApi(opts: { registry: FakePluginRegistry; secrets: SecretStore; send: (url: string, init: RequestInit) => Promise<Response>; asked: Asked[] }): ApiRouter {
  return async ({ pluginId, path, args }) => {
    if (path !== "net.fetch") throw new ContractError("refused", `${path} isn't served in this test`);
    const [url, init = {}, fetchOpts] = args as [string, RequestInit | undefined, KeyedFetchOptions | undefined];
    const headers = new Headers(init.headers);
    opts.asked.push({ url, opts: fetchOpts, ownHeader: headers.has("authorization") });
    const manifest = opts.registry.get(pluginId)?.manifest;
    if (manifest === undefined) throw new KeyedFetchError("refused", `${pluginId} isn't running`);
    const u = new URL(url);
    if (u.protocol !== "https:") throw new KeyedFetchError("insecure_url", "only https");
    if (!(manifest.capabilities ?? []).includes(`network:${u.host}`)) throw new KeyedFetchError("host_not_declared", `${u.host} isn't one of ${pluginId}'s hosts`);
    const entries = (manifest.auth ?? []).filter((a): a is KeyedAuth => "secret" in a);
    const name = fetchOpts?.auth ?? (entries.length === 1 ? entries[0]!.secret : entries.length === 0 ? false : undefined);
    if (name === undefined) throw new KeyedFetchError("ambiguous_auth", "name the auth entry");
    if (name === false) return opts.send(url, { ...init, headers, redirect: "manual" });
    const entry = entries.find((a) => a.secret === name);
    if (entry === undefined) throw new KeyedFetchError("unknown_auth", `${pluginId} has no auth entry ${name}`);
    const item = await opts.secrets.get({ owner: { kind: "plugin", pluginId }, name });
    if (item === null) throw new KeyedFetchError("no_credential", `no key saved for ${name}`);
    const key = item.value.reveal();
    const placed = keyHeaderFor(entry.placement, key);
    if (placed === null) throw new KeyedFetchError("refused", `${name}'s placement isn't one the core uses`);
    if (headers.has(placed.header)) throw new KeyedFetchError("credential_header", `the core sets ${placed.header}`);
    headers.set(placed.header, placed.value);
    const res = await opts.send(url, { ...init, headers, redirect: "manual" });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: stripEchoedKey(res.headers, key) });
  };
}

/** The `clover` plugin with Fish Audio as its child, laid out as the plugin SDK reads a tree (`<parent>/plugins/<child>`;
 *  the repo keeps `plugins/clover/fish-audio` until lane M moves the children), validated and held in the registry.
 *  The parent's manifest is the repo's once lane M's skeleton is in, else the least one. */
async function installed() {
  const root = join(tempDir(), "clover");
  mkdirSync(root, { recursive: true });
  const parent = join(REPO, "plugins", "clover", "clover.json");
  writeFileSync(join(root, "clover.json"), existsSync(parent) ? readFileSync(parent, "utf8") : `${JSON.stringify({ manifest: 1, id: "clover", name: "Clover" })}\n`);
  cpSync(join(REPO, "plugins", "clover", "fish-audio"), join(root, "plugins", "fish-audio"), { recursive: true });
  const { report, inputs } = await pluginFromFolder(root, { bundled: true });
  const registry = new FakePluginRegistry({ plugins: inputs });
  return { report, inputs, registry };
}

async function running(opts: { key?: string; fish?: FakeFish } = {}) {
  const { registry } = await installed();
  const record = registry.get(PLUGIN) as PluginRecord;
  const clock = new FakeClock();
  const host = new FakePluginHost({ clock });
  // The core loads the host half from the entry the manifest names, in the plugin's folder.
  host.define(PLUGIN, (await import(join(record.folder, record.manifest!.host!.entry))) as HostModule);
  const secrets = new MemorySecretStore();
  if (opts.key !== undefined) await secrets.set(KEY_REF, opts.key);
  const fish = opts.fish ?? new FakeFish({ key: KEY, ttfaMs: 0, chunkMs: 0, balanceUsd: 1 });
  const asked: Asked[] = [];
  const sent: { url: string; authorization: string | null }[] = [];
  host.serveApi(servePluginApi({
    registry, secrets, asked,
    send: (url, init) => {
      sent.push({ url, authorization: new Headers(init.headers).get("authorization") });
      return fish.fetch(url, init);
    },
  }));
  const call = <R>(method: "speak" | "listen", args: unknown) => host.invoke<R>({ pluginId: PLUGIN, handler: "voice", method, args, caller: { kind: "core" } });
  return { registry, host, secrets, fish, asked, sent, call };
}

async function failure(p: Promise<unknown>): Promise<ContractError> {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(ContractError);
  return err as ContractError;
}

describe("the Fish Audio plugin in the core", () => {
  test("it validates as clover/fish-audio, and its voice comes up in the registry", async () => {
    const { report, inputs, registry } = await installed();
    expect(report.top.issues.filter((i) => i.severity === "error")).toEqual([]);
    const child = report.children.find((c) => c.folder === "fish-audio");
    expect(child?.ok).toBe(true);
    expect(child?.report.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(inputs.map((i) => i.id)).toEqual(["clover", PLUGIN]);
    expect(registry.get(PLUGIN)?.state).toBe("running");
    expect(registry.entries("voices")).toMatchObject([
      { pluginId: PLUGIN, entryId: "fish-audio", state: "active", value: { name: "Fish Audio", speak: true, listen: true, handler: "voice" } },
    ]);
    const manifest = registry.get(PLUGIN)!.manifest!;
    expect(manifest.capabilities).toEqual(["network:api.fish.audio"]);
    expect(manifest.auth).toMatchObject([{ method: "api-key", secret: "fish-api-key" }]);
    expect(manifest.host).toMatchObject({ entry: "host/index.ts" });
    // The stand-in fetch's codes are the plugin API's own.
    for (const code of ["no_credential", "host_not_declared", "credential_header"]) expect(KEYED_FETCH_ERROR_CODES).toContain(code as KeyedFetchErrorCode);
  });

  test("the core calls its voice to speak and to listen; the key goes in at the core, never through the plugin", async () => {
    const { call, fish, asked, sent } = await running({ key: KEY });
    const said = "Good morning! Your first meeting is at ten.";
    const spoken = await call<SpeakResult>("speak", { text: said, voice: VOICE });
    expect(spoken).toMatchObject({ model: "s2.1-pro-free", format: "pcm16-24k" });
    expect(spoken.audio.length).toBeGreaterThan(0);
    expect(spoken.audio.length % 2).toBe(0);
    const heard = await call<ListenResult>("listen", { audio: spoken.audio, format: "pcm16-16k", language: "en" });
    expect(heard).toMatchObject({ text: said, languageCode: "en" });
    // The plugin named its auth entry and set no key of its own; every request reached Fish with the key, and only Fish.
    expect(asked).toEqual([
      { url: "https://api.fish.audio/v1/tts", opts: { auth: "fish-api-key" }, ownHeader: false },
      { url: "https://api.fish.audio/v1/asr", opts: { auth: "fish-api-key" }, ownHeader: false },
    ]);
    expect(sent.every((s) => s.authorization === `Bearer ${KEY}` && new URL(s.url).host === "api.fish.audio")).toBe(true);
    expect(fish.calls.map((c) => [c.path, c.status, c.billedModel])).toEqual([["/v1/tts", 200, "s2.1-pro-free"], ["/v1/asr", 200, "transcribe-1"]]);
    expect(JSON.stringify([spoken.model, spoken.format, heard])).not.toContain(KEY);
  });

  test("with no key saved, speaking fails at once and says why: the bot stays text-only", async () => {
    const { call, fish, asked } = await running();
    const err = await failure(call("speak", { text: "Hello?", voice: VOICE }));
    expect(err.code).toBe("failed");
    expect(err.message).toContain("no Fish Audio key");
    expect(asked).toHaveLength(1); // not retried
    expect(fish.calls).toEqual([]);
  });

  test("a wrong key is Fish's refusal, and no message carries the key", async () => {
    const { call, fish } = await running({ key: "the-wrong-key" });
    const err = await failure(call("speak", { text: "Hello?", voice: VOICE }));
    expect(err.message).toContain("Invalid API key");
    expect(err.message).not.toContain("the-wrong-key");
    expect(JSON.stringify(err)).not.toContain("the-wrong-key");
    expect(fish.calls).toMatchObject([{ path: "/v1/tts", status: 401, authorized: false }]);
  });
});
