// What each manifest field does end to end, on the real registry (`RegistryCore` with the real rules), not a fake:
// `commands[].key`, `enabledByDefault`, `adult`, `locales`, `platforms`, `scope`, `onlyBackends` and a setting's `scope`.
// (Lane B's audit, row 26: each was UNIT or UNTESTED.) The pieces after the registry are the real ones too: the
// command view, the UI view, the host gate, the Glossary's `serves`, the plugin MCP listing's scope, the settings store.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogPointDecl } from "@waifucave/clover-plugin-sdk";
import { commandViews } from "../../commands/views";
import type { Manifest } from "../../contracts/sdk-types";
import { currentPlatform, hostedRecordOf } from "../../plugin-host/daemon-host";
import { filePluginSettings, PluginSettings } from "../../plugin-host/api/settings";
import { uiPluginViews } from "../../plugin-host/ui";
import { glossaryIndex } from "../../runtime-sdk/turn-loop/glossary";
import { glossaryServes, servesPlugin } from "../../runtime-sdk/turn-loop/serves";
import { RegistryCore } from "../core";
import { memoryRegistryStore } from "../state";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "clover-fields-"));
  dirs.push(d);
  return d;
};

const m = (over: Record<string, unknown> = {}): Manifest => ({ manifest: 1, name: "A plugin", ...over }) as Manifest;
const registryOf = (inputs: Parameters<RegistryCore["putAll"]>[0], adult = false) => {
  const reg = new RegistryCore({ catalog: catalogPointDecl, store: memoryRegistryStore({ adult }) });
  reg.putAll(inputs);
  return reg;
};

describe("commands[].key", () => {
  test("a free chord is bound; the app's chord, a bare key and two plugins on one chord are not, and say why", () => {
    const cmd = (name: string, key: string) => ({ name, description: name, handler: name, key });
    const reg = registryOf([
      { id: "a", manifest: m({ id: "a", contributes: { commands: [cmd("go", "mod+shift+k"), cmd("quit", "mod+q"), cmd("bare", "k"), cmd("clash", "mod+j")] } }), treeHash: "sha256:a", approved: true },
      { id: "b", manifest: m({ id: "b", contributes: { commands: [cmd("clash", "meta+j")] } }), treeHash: "sha256:b", approved: true },
    ]);
    const by = Object.fromEntries(commandViews(reg, "darwin").map((c) => [c.name, c.keyState]));
    expect(by["a.go"]).toEqual({ state: "bound", chord: "shift+meta+k" });
    expect(by["a.quit"]).toEqual({ state: "app", what: "Quit" });
    expect(by["a.bare"]).toEqual({ state: "bare" });
    expect(by["a.clash"]).toEqual({ state: "clash", with: ["b.clash"] });
    expect(by["b.clash"]).toEqual({ state: "clash", with: ["a.clash"] });
  });
  test("a plugin that is off has no command, so its chord frees up", () => {
    const reg = registryOf([
      { id: "a", manifest: m({ id: "a", contributes: { commands: [{ name: "x", description: "x", handler: "x", key: "mod+j" }] } }), treeHash: "sha256:a", approved: true },
      { id: "b", manifest: m({ id: "b", contributes: { commands: [{ name: "x", description: "x", handler: "x", key: "mod+j" }] } }), treeHash: "sha256:b", approved: true, enabled: false },
    ]);
    expect(commandViews(reg, "linux").map((c) => [c.name, c.keyState])).toEqual([["a.x", { state: "bound", chord: "ctrl+j" }]]);
  });
});

describe("enabledByDefault (children)", () => {
  test("a child that says false is off after its parent's OK, and its checkbox on the card starts unticked; one that says nothing is on", async () => {
    let seen: { id: string; checked: boolean }[] = [];
    const reg = new RegistryCore({
      catalog: catalogPointDecl, store: memoryRegistryStore(),
      cards: { raise: (req) => { seen = req.children.map((c) => ({ id: c.id, checked: c.checked })); return "card_1"; } },
    });
    reg.putAll([
      { id: "pack", manifest: m({ name: "Pack" }), treeHash: "sha256:1", approved: false },
      { id: "pack/extra", manifest: m({ name: "Extra", enabledByDefault: false }), treeHash: "sha256:1" },
      { id: "pack/core", manifest: m({ name: "Core" }), treeHash: "sha256:1" },
    ]);
    // Its OK card is raised for the tree: each child's checkbox starts as its default.
    await reg.setEnabled("pack", true);
    expect(seen.sort((x, y) => x.id.localeCompare(y.id))).toEqual([{ id: "pack/core", checked: true }, { id: "pack/extra", checked: false }]);
    expect(await reg.approve("pack", "sha256:1")).toBe("approved");
    expect([reg.get("pack/extra")?.state, reg.get("pack/core")?.state]).toEqual(["off", "running"]);
    // The user ticks it later: it runs.
    await reg.setEnabled("pack/extra", true);
    expect(reg.get("pack/extra")?.state).toBe("running");
  });
  test("it is for children only: a top-level plugin that says false still starts on", () => {
    const reg = registryOf([{ id: "solo", manifest: m({ enabledByDefault: false }), treeHash: "sha256:s", approved: true }]);
    expect(reg.get("solo")?.state).toBe("running");
  });
});

describe("adult", () => {
  test("a plugin that says adult is off, with the reason, until the user confirms 18+; its children go with it", () => {
    const store = memoryRegistryStore();
    const reg = new RegistryCore({ catalog: catalogPointDecl, store });
    reg.putAll([
      { id: "spicy", manifest: m({ name: "Spicy", adult: true }), treeHash: "sha256:1", approved: true },
      { id: "spicy/kid", manifest: m({ name: "Kid" }), treeHash: "sha256:1", approved: true },
      { id: "mild", manifest: m({ name: "Mild" }), treeHash: "sha256:2", approved: true },
    ]);
    expect(reg.adultConfirmed).toBe(false);
    expect(reg.get("spicy")).toMatchObject({ state: "off", reason: "may contain adult content: off until you confirm you are 18 or older" });
    expect(reg.get("spicy/kid")?.state).toBe("off");
    expect(reg.get("mild")?.state).toBe("running");
    reg.confirmAdult();
    expect(reg.adultConfirmed).toBe(true);
    expect([reg.get("spicy")?.state, reg.get("spicy/kid")?.state]).toEqual(["running", "running"]);
    // The confirmation is kept (a restart on the same records).
    expect(new RegistryCore({ catalog: catalogPointDecl, store }).adultConfirmed).toBe(true);
  });
  test("with the confirmation already given, it runs at once", () => {
    expect(registryOf([{ id: "spicy", manifest: m({ adult: true }), treeHash: "sha256:1", approved: true }], true).get("spicy")?.state).toBe("running");
  });
});

describe("locales", () => {
  test("a plugin's locale files are in its UI view, by language, while it runs; off, they are gone", async () => {
    const reg = registryOf([{
      id: "lingua", manifest: m({ id: "lingua", contributes: { locales: [{ lang: "en", file: "locales/en.json" }, { lang: "de", file: "locales/de.json" }] } }), treeHash: "sha256:l", approved: true,
    }]);
    expect(uiPluginViews(reg).find((v) => v.pluginId === "lingua")?.locales).toEqual([{ lang: "en", file: "locales/en.json" }, { lang: "de", file: "locales/de.json" }]);
    await reg.setEnabled("lingua", false);
    expect(uiPluginViews(reg).find((v) => v.pluginId === "lingua")).toBeUndefined();
  });
});

describe("platforms", () => {
  const entry = (platforms: string[] | undefined) => ({ id: "native", manifest: m({ id: "native", host: { entry: "host/index.js" }, ...(platforms === undefined ? {} : { platforms }) }), treeHash: "sha256:n", approved: true, folder: "/tmp/native" });
  test("the host half starts only on a listed platform; unlisted means everywhere", () => {
    const home = temp();
    const only = registryOf([entry(["linux-x64"])]);
    expect(hostedRecordOf(only, home, "native", undefined, "linux-x64")).toMatchObject({ id: "native", entry: "host/index.js" });
    expect(hostedRecordOf(only, home, "native", undefined, "darwin-arm64")).toBeUndefined();
    // No platform named is this machine's own (the parameter's default), so a list of linux-x64 alone starts there and nowhere else.
    expect(hostedRecordOf(only, home, "native", undefined, undefined)?.id).toBe(currentPlatform() === "linux-x64" ? "native" : undefined);
    const any = registryOf([entry(undefined)]);
    for (const p of ["darwin-arm64", "windows-x64", "linux-x64", "linux-arm64"] as const) expect(hostedRecordOf(any, home, "native", undefined, p)?.id).toBe("native");
  });
  test("a child follows its tree's list, and its own wins", () => {
    const home = temp();
    const reg = registryOf([
      { id: "tree", manifest: m({ platforms: ["windows-x64"] }), treeHash: "sha256:t", approved: true, folder: "/tmp/tree" },
      { id: "tree/a", manifest: m({ host: { entry: "a.js" } }), treeHash: "sha256:t", approved: true, folder: "/tmp/tree/a" },
      { id: "tree/b", manifest: m({ host: { entry: "b.js" }, platforms: ["linux-x64"] }), treeHash: "sha256:t", approved: true, folder: "/tmp/tree/b" },
    ]);
    expect(hostedRecordOf(reg, home, "tree/a", undefined, "windows-x64")?.id).toBe("tree/a");
    expect(hostedRecordOf(reg, home, "tree/a", undefined, "linux-x64")).toBeUndefined();
    expect(hostedRecordOf(reg, home, "tree/b", undefined, "linux-x64")?.id).toBe("tree/b");
  });
  test("this process is one of the daemon's four targets by os and arch", () => {
    expect(currentPlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(currentPlatform("win32", "x64")).toBe("windows-x64");
    expect(currentPlatform("linux", "x64")).toBe("linux-x64");
    expect(currentPlatform("linux", "arm64")).toBe("linux-arm64");
    expect(currentPlatform("darwin", "x64")).toBeUndefined();
  });
});

describe("scope and onlyBackends", () => {
  /** A plugin with one skill, over the real registry; the Glossary's index for a session says who sees it. */
  function skills() {
    const root = temp();
    const plugin = (id: string, over: Record<string, unknown>) => {
      const folder = join(root, id);
      mkdirSync(join(folder, "skills", "s"), { recursive: true });
      writeFileSync(join(folder, "skills", "s", "SKILL.md"), `---\nname: ${id}-skill\ndescription: ${id}\n---\nbody of ${id}\n`);
      return { id, manifest: m({ id, contributes: { skills: ["skills/*/SKILL.md"] }, ...over }), treeHash: `sha256:${id}`, approved: true, folder };
    };
    return registryOf([plugin("both", {}), plugin("botsonly", { scope: "bots" }), plugin("agentsonly", { scope: "agents" }), plugin("cc", { onlyBackends: ["claude-code"] })]);
  }
  const seenBy = (reg: RegistryCore, session: { kind: "bot" | "side-thread" | "agent" | "coding"; bot?: string }, backend?: string) =>
    glossaryIndex({ tools: () => [], registry: reg, serves: glossaryServes(reg, session, backend) }).filter((i) => i.kind === "skill").map((i) => i.name).sort();

  test("scope bots / agents / both decides whose Glossary lists a plugin's skills", () => {
    const reg = skills();
    // (`cc` names a backend and says nothing of scope: both; a bot isn't a backend, so it sees it.)
    const forBots = ["both:both-skill", "botsonly:botsonly-skill", "cc:cc-skill"];
    expect(seenBy(reg, { kind: "bot", bot: "luna" })).toEqual(forBots);
    expect(seenBy(reg, { kind: "side-thread", bot: "luna" })).toEqual(forBots);
    // A bot's delegation counts as the bots' (a guard scoped to bots is never got around by delegating); the user's own coding session is the agents'.
    expect(seenBy(reg, { kind: "agent", bot: "luna" }, "claude-code")).toEqual(["agentsonly:agentsonly-skill", "both:both-skill", "botsonly:botsonly-skill", "cc:cc-skill"]);
    expect(seenBy(reg, { kind: "coding" }, "claude-code")).toEqual(["agentsonly:agentsonly-skill", "both:both-skill", "cc:cc-skill"]);
  });
  test("onlyBackends: an agent on another backend, or one whose backend is unknown, doesn't get it; a bot is not a backend and is unaffected", () => {
    const reg = skills();
    expect(seenBy(reg, { kind: "coding" }, "codex")).toEqual(["agentsonly:agentsonly-skill", "both:both-skill"]);
    expect(seenBy(reg, { kind: "coding" })).toEqual(["agentsonly:agentsonly-skill", "both:both-skill"]);
    expect(seenBy(reg, { kind: "bot", bot: "luna" })).toContain("cc:cc-skill");
    expect(servesPlugin({ onlyBackends: ["claude-code", "codex"] }, { kind: "agent" }, "codex")).toBe(true);
    expect(servesPlugin(undefined, { kind: "agent" })).toBe(true);
  });
});

describe("a setting's scope: account, device, bot", () => {
  test("each lands in its own part of the plugin's file; a bot value is one per bot and needs its bot; the others refuse one", () => {
    const home = temp();
    const reg = registryOf([{
      id: "luna", manifest: m({ id: "luna", settings: {
        greeting: { type: "string", title: "Greeting", default: "hi" },
        tint: { type: "color", title: "Tint", scope: "device" },
        nick: { type: "string", title: "Nick", scope: "bot" },
      } }), treeHash: "sha256:l", approved: true,
    }]);
    const settings = new PluginSettings({ registry: reg, backend: filePluginSettings(home) });
    settings.set("luna", "greeting", "yo");
    settings.set("luna", "tint", "#112233");
    settings.set("luna", "nick", "Lu", "alpha");
    settings.set("luna", "nick", "Bea", "beta");
    expect(JSON.parse(readFileSync(join(home, "settings", "plugins", "luna.json"), "utf8"))).toEqual({
      account: { greeting: "yo" }, device: { tint: "#112233" }, bot: { alpha: { nick: "Lu" }, beta: { nick: "Bea" } },
    });
    expect(settings.get("luna", "nick", "alpha")).toBe("Lu");
    expect(settings.get("luna", "nick", "beta")).toBe("Bea");
    expect(() => settings.set("luna", "nick", "x")).toThrow();
    // A bot named for a setting that isn't a bot's is ignored: nothing lands under that bot.
    settings.set("luna", "greeting", "again", "alpha");
    expect(JSON.parse(readFileSync(join(home, "settings", "plugins", "luna.json"), "utf8")).bot.alpha).toEqual({ nick: "Lu" });
    expect(settings.get("luna", "greeting")).toBe("again");
    // A new store over the same file reads the same values.
    expect(new PluginSettings({ registry: reg, backend: filePluginSettings(home) }).get("luna", "tint")).toBe("#112233");
  });
});
