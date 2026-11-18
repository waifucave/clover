// The SDK's full examples (packages/plugin-sdk/examples): each installs as it ships, the way a user installs a folder,
// and its OK card says what the pair is there to teach. `example-notes` stays inside (no network, no capability): its
// `contained` and `readOnly` tools are named as running without asking, and nothing about the network. `example-weather`
// reaches outside (its own host, notifications): the same two lists are said to still ask. Temp homes; no window.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_BARE_IMPORTS } from "@waifucave/moss-plugin-sdk";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { openPluginRegistry } from "../../registry/open";
import { buildPluginModule } from "../../registry/build";
import { renderValidation, validatePluginFolder } from "../../registry/validate";
import { pluginRegistryMethods } from "../registry-methods";
import { pluginToolContained, pluginToolReadOnly } from "../../registry/read-only-tools";
import { pluginHooks, type HookSession } from "../../runtime-sdk/turn-loop/hooks";
import type { InvokeRequest } from "../../contracts/plugin-host";
import type { Caller } from "@waifucave/moss-protocol";
import { Notes, NOTE_TEXT_MAX, readNotes } from "../../../../plugin-sdk/examples/example-notes/server/notes";

const EXAMPLES = join(import.meta.dir, "..", "..", "..", "..", "plugin-sdk", "examples");
const temps: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const APP = { caller: { kind: "user", client: "app" } } as never;

async function until<T>(what: string, ms: number, f: () => T | undefined): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`);
    await Bun.sleep(20);
  }
}

/** The card's lines, as the broker holds them (a plugin-ok card's sealed list). */
const cardText = (card: unknown): string => JSON.stringify(card);

describe("the SDK's examples install as they ship", () => {
  test("the examples are there, and each validates with no error and no node_modules", async () => {
    expect(readdirSync(EXAMPLES).sort()).toEqual(["example-notes", "example-pngtuber", "example-weather"]);
    for (const id of ["example-notes", "example-pngtuber", "example-weather"]) {
      expect([id, existsSync(join(EXAMPLES, id, "node_modules"))]).toEqual([id, false]);
      const v = await validatePluginFolder(join(EXAMPLES, id), { os: "macos" });
      expect({ id, ok: v.ok, errors: v.issues.filter((i) => i.severity === "error") }).toEqual({ id, ok: true, errors: [] });
    }
  });

  test("the validate report names what each plugin brings, with the same labels the registry's records carry; a parent's include its child's", async () => {
    // No example brings a bot (G8): Notes brings tools, a hook and its page; none of its labels is a bot's.
    const v = await validatePluginFolder(join(EXAMPLES, "example-notes"), { os: "macos" });
    expect(v.plugin!.labels).toEqual(expect.arrayContaining(["Tools", "Hooks", "App page"]));
    expect(v.plugin!.labels).not.toContain("Bot");
    expect(v.children).toEqual([]);
    expect(renderValidation(v)).toContain("brings: ");
    expect(renderValidation(v)).not.toMatch(/brings:[^\n]*(plugin|type|kind)/i);
    // A parent's labels include its child's: a folder of the run's own with a child that brings a theme.
    const dir = join(temp("moss-d-parent-"), "acme-parent");
    mkdirSync(join(dir, "plugins", "look", "theme"), { recursive: true });
    writeFileSync(join(dir, "moss.json"), JSON.stringify({ manifest: 1, id: "acme-parent", name: "Parent", version: "1.0.0", engines: { moss: "^1.0.0" }, contributes: { commands: [{ name: "hi", description: "Says hi.", handler: "hi" }] }, host: { entry: "server.ts", runtime: "bun" } }));
    writeFileSync(join(dir, "server.ts"), "export async function hi() { return { text: \"hi\" }; }\n");
    writeFileSync(join(dir, "plugins", "look", "moss.json"), JSON.stringify({ manifest: 1, name: "Look", contributes: { themes: [{ id: "look", file: "theme/theme.json" }] } }));
    writeFileSync(join(dir, "plugins", "look", "theme", "theme.json"), JSON.stringify({ tokens: { "color.canvas": "#FFFFFF" } }));
    const pv = await validatePluginFolder(dir, { os: "macos" });
    const child = pv.children[0]!;
    expect(child.labels.length).toBeGreaterThan(0);
    expect(pv.plugin!.labels).toEqual(expect.arrayContaining(child.labels));
  });

  test("example-notes: installed, OK'd and running, with no bot; its card names its cardless tools, its hook and no network; its two lists hold", async () => {
    const home = temp("moss-d-examples-");
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const opened = await openPluginRegistry({ mossHome: home, os: "macos", hostNetworkHeld: true, sandboxed: true, broker, secrets: new MemorySecretStore(), settleMs: 50 });
    const m = pluginRegistryMethods({ opened, host: { restart: async () => {} }, home });
    try {
      const r = (await m["plugin.install"]!({ source: { from: "folder", path: join(EXAMPLES, "example-notes") } }, APP)) as { id: string; state: string; treeHash: string; card?: string };
      expect([r.id, r.state]).toEqual(["example-notes", "found"]);
      const card = broker.cards().find((c) => c.id === r.card);
      expect(card).toMatchObject({ kind: "plugin-ok", pluginId: "example-notes" });
      const text = cardText(card);
      expect(text).toContain("this tool only reads, so at the default approval level it runs without asking: list_notes");
      expect(text).toContain("this tool only changes its own display, so at the default level it runs without asking: add_note");
      expect(text).toContain("Its hooks see your conversations: what each tool returns.");
      expect(text).toContain("Notes tidier");
      expect(text).not.toMatch(/network|still asks|notifications/i);
      expect(await opened.registry.approve(r.id, r.treeHash)).toBe("approved");
      const rec = opened.registry.get("example-notes");
      expect(rec?.state).toBe("running");
      expect(opened.registry.get("example-notes/bot")).toBeUndefined();
      // The rule the pair teaches, from the registry's own predicates: here the two lists hold, and delete_note is on
      // neither (it asks). (`fenced`: the rule as a computer whose plugin fence holds.)
      expect(pluginToolContained(opened.registry, "example-notes", "notes", "add_note", { fenced: true })).toBe(true);
      expect(pluginToolReadOnly(opened.registry, "example-notes", "notes", "list_notes", { fenced: true })).toBe(true);
      expect(pluginToolContained(opened.registry, "example-notes", "notes", "delete_note", { fenced: true })).toBe(false);
      expect(pluginToolReadOnly(opened.registry, "example-notes", "notes", "delete_note", { fenced: true })).toBe(false);
      // Its hook counts its OWN tools' calls by the HOST's tool filter, not the example's code: the host invokes it after a
      // call of one of its tools in a bot's session and in a code session alike (a code session runs no turn hooks, only the
      // bridge's tool hooks), and never after another plugin's tool. The example's handler holds no check of its own.
      const invoked: { pluginId: string; handler: string; tool?: string }[] = [];
      const hooks = pluginHooks({
        registry: opened.registry,
        host: { invoke: (async (req: InvokeRequest) => void invoked.push({ pluginId: req.pluginId, handler: req.handler, tool: (req.args as { tool?: { name?: string } }).tool?.name })) as never },
      });
      const as = (kind: HookSession["kind"], bot?: string): HookSession => ({
        id: `s_${bot ?? "me"}_${kind}`, kind, computer: "Studio", ...(bot === undefined ? {} : { bot }),
        caller: { kind: "session", sessionId: `s_${bot ?? "me"}_${kind}`, sessionKind: kind, ...(bot === undefined ? {} : { bot }) } as Caller,
      });
      const call = (name: string) => ({ name, callId: `call_${name}` });
      await hooks.toolAfter(as("bot", "alpha"), call("mcp__acme-other__add_note"), {}, { content: [] });
      await hooks.toolAfter(as("coding"), call("mcp__acme-other__add_note"), {}, { content: [] });
      expect(invoked).toEqual([]);
      const result = { content: [{ type: "text", text: "Noted: milk" }] };
      expect(await hooks.toolAfter(as("bot", "alpha"), call("mcp__example-notes-notes__add_note"), { text: "milk" }, result)).toEqual(result);
      expect(await hooks.toolAfter(as("coding"), call("mcp__example-notes-notes__list_notes"), {}, result)).toEqual(result);
      // An observer: it is told after the call, and the result goes on unchanged.
      await until("its hook told of both calls", 5_000, () => (invoked.length === 2 ? true : undefined));
      expect(invoked.map((i) => [i.pluginId, i.handler, i.tool])).toEqual([["example-notes", "onToolAfter", "mcp__example-notes-notes__add_note"], ["example-notes", "onToolAfter", "mcp__example-notes-notes__list_notes"]]);
      expect(readFileSync(join(EXAMPLES, "example-notes", "server", "index.ts"), "utf8")).not.toMatch(/tool\??\.name\s*(!==|===)/);
      // Its client, TSX importing React and the UI SDK, builds to the layer's imports only.
      const built = await buildPluginModule({ entry: join(home, "plugins", "example-notes", "client", "index.tsx"), outFile: join(temp("moss-d-ex-out-"), "index.js"), side: "client" });
      for (const spec of built.imports) expect([spec, (CLIENT_BARE_IMPORTS as readonly string[]).includes(spec)]).toEqual([spec, true]);
    } finally {
      opened.close();
    }
  });

  test("example-pngtuber: a third-party renderer for the avatar plugin installs from its folder; it waits for the plugins whose points it fills, and its TSX builds to the layer's imports only", async () => {
    const home = temp("moss-d-pngtuber-");
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const opened = await openPluginRegistry({ mossHome: home, os: "macos", hostNetworkHeld: true, sandboxed: true, broker, secrets: new MemorySecretStore(), settleMs: 50 });
    const m = pluginRegistryMethods({ opened, host: { restart: async () => {} }, home });
    try {
      const r = (await m["plugin.install"]!({ source: { from: "folder", path: join(EXAMPLES, "example-pngtuber") } }, APP)) as { id: string; treeHash: string };
      expect(await opened.registry.approve(r.id, r.treeHash)).toBe("approved");
      expect(opened.registry.get("example-pngtuber")?.state).toBe("running");
      // Every point it plugs into is a plugin's own (the avatar plugin's spot, formats and packs; MOSS Voice's speech), which a
      // bare registry has not got: it waits for each. Nothing of it is the platform's.
      expect([...(opened.registry.get("example-pngtuber")?.waitingFor ?? [])].sort()).toEqual(["moss.character.formats", "moss.character.packs", "moss.character.renderer", "moss.voice.speech"]);
      const built = await buildPluginModule({ entry: join(home, "plugins", "example-pngtuber", "client", "index.tsx"), outFile: join(temp("moss-d-pt-out-"), "index.js"), side: "client" });
      for (const spec of built.imports) expect([spec, (CLIENT_BARE_IMPORTS as readonly string[]).includes(spec)]).toEqual([spec, true]);
    } finally {
      opened.close();
    }
  });

  test("example-weather: installed and OK'd; its card names its host and notifications, and says its readOnly and contained tools still ask; the lists don't hold", async () => {
    const home = temp("moss-d-examples-w-");
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const opened = await openPluginRegistry({ mossHome: home, os: "macos", hostNetworkHeld: true, sandboxed: true, broker, secrets: new MemorySecretStore(), settleMs: 50 });
    const m = pluginRegistryMethods({ opened, host: { restart: async () => {} }, home });
    try {
      const r = (await m["plugin.install"]!({ source: { from: "folder", path: join(EXAMPLES, "example-weather") } }, APP)) as { id: string; treeHash: string; card?: string };
      const text = cardText(broker.cards().find((c) => c.id === r.card));
      expect(text).toContain("api.example.com");
      expect(text).toContain("It sends you notifications");
      expect(text).toContain("Its server forecast says one tool only reads, but it can reach the network, so it still asks before running");
      expect(text).toContain("Its server forecast says one tool only changes its own display, but it can reach the network or do more than read MOSS's state, so it still asks before running");
      expect(text).not.toContain("runs without asking");
      expect(await opened.registry.approve(r.id, r.treeHash)).toBe("approved");
      expect(pluginToolReadOnly(opened.registry, "example-weather", "forecast", "forecast", { fenced: true })).toBe(false);
      expect(pluginToolContained(opened.registry, "example-weather", "forecast", "save_place", { fenced: true })).toBe(false);
    } finally {
      opened.close();
    }
  });
});

describe("the Notes example's own logic", () => {
  const store = () => {
    const kept = new Map<string, unknown>();
    return { kept, get: async (k: string) => structuredClone(kept.get(k)), set: async (k: string, v: unknown) => void kept.set(k, structuredClone(v)) };
  };

  test("notes are added in one line, handles reused once freed, deleted by handle; the turn count moves", async () => {
    const s = store();
    let now = 1_000;
    const n = new Notes(s, () => ++now);
    expect(await n.add("  Buy\nmilk\u202e ")).toMatchObject({ ok: true, note: { id: "n1", text: "Buy milk" } });
    expect(await n.add("x".repeat(500))).toMatchObject({ ok: true, note: { id: "n2", text: "x".repeat(NOTE_TEXT_MAX) } });
    expect(await n.add("   ")).toEqual({ ok: false, said: "A note needs some text." });
    expect(await n.delete("n1")).toMatchObject({ ok: true, note: { text: "Buy milk" } });
    expect(await n.delete("n1")).toMatchObject({ ok: false });
    expect(await n.add("Call back")).toMatchObject({ note: { id: "n1" } });
    // Two adds at once both land (one chain).
    await Promise.all([n.add("a"), n.add("b")]);
    expect((await n.list()).map((x) => x.text)).toEqual(["x".repeat(NOTE_TEXT_MAX), "Call back", "a", "b"]);
    expect(await n.countUse()).toBe(1);
    expect(await n.countUse()).toBe(2);
    expect(readNotes([{ id: "n1", text: "ok", at: 1 }, { id: 2 }, "junk", null])).toEqual([{ id: "n1", text: "ok", at: 1 }]);
  });

  test("the host half: its tools, the hook (its own tools only) and the command, over a fake store", async () => {
    const s = store();
    const host = await import("../../../../plugin-sdk/examples/example-notes/server/index");
    host.start({ plugin: { id: "example-notes" }, storage: { synced: s } } as never);
    expect(await host.note({ text: "From the slash menu" })).toEqual({ text: "Noted: From the slash menu" });
    await host.onToolAfter({ tool: { name: "mcp__example-notes-notes__add_note" } });
    expect(await host.ui!.list!(undefined, {} as never)).toMatchObject({ notes: [{ text: "From the slash menu" }], uses: 1 });
    const hook = JSON.parse(readFileSync(join(EXAMPLES, "example-notes", "moss.json"), "utf8")).contributes.hooks[0];
    expect(hook).toMatchObject({ on: ["tool.after"], tools: ["mcp__example-notes-notes__*"], observe: true });
    expect(hook.scope).toBeUndefined();
    host.stop();
  });
});
