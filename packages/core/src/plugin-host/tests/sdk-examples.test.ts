// The SDK's full examples (packages/plugin-sdk/examples): each installs as it ships, the way a user installs a folder,
// and its OK card says what the pair is there to teach. `example-notes` stays inside (no network, no capability): its
// `contained` and `readOnly` tools are named as running without asking, and nothing about the network. `example-weather`
// reaches outside (its own host, notifications): the same two lists are said to still ask. Temp homes; no window.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_BARE_IMPORTS, resolveShell } from "@waifucave/clover-plugin-sdk";
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
import type { Caller } from "@waifucave/clover-protocol";
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

/** A second bot plugin, in a temp folder of its own: a bot and nothing else. */
const botPlugin = (id: string): string => {
  const dir = join(temp(`clover-d-bot-${id}-`), id);
  mkdirSync(join(dir, "bot"), { recursive: true });
  writeFileSync(join(dir, "bot", "instructions.md"), "Be kind.\n");
  writeFileSync(join(dir, "clover.json"), JSON.stringify({ manifest: 1, id, name: id, version: "1.0.0", engines: { clover: "^1.0.0" }, contributes: { bot: { name: id, instructions: "bot/instructions.md" } } }));
  return dir;
};

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
    const v = await validatePluginFolder(join(EXAMPLES, "example-notes"), { os: "macos" });
    expect(v.plugin!.labels).toEqual(expect.arrayContaining(["Tools", "Bot"]));
    const child = v.children.find((c) => c.labels.includes("Bot"))!;
    expect(child.labels).toContain("Bot");
    expect(v.plugin!.labels).toEqual(expect.arrayContaining(child.labels));
    expect(renderValidation(v)).toContain("brings: ");
    expect(renderValidation(v)).not.toMatch(/brings:[^\n]*(plugin|type|kind)/i);
  });

  test("example-notes: installed, OK'd and running with its child bot; its card names its cardless tools and no network; its two lists hold", async () => {
    const home = temp("clover-d-examples-");
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets: new MemorySecretStore(), settleMs: 50 });
    const m = pluginRegistryMethods({ opened, host: { restart: async () => {} }, home });
    try {
      const r = (await m["plugin.install"]!({ source: { from: "folder", path: join(EXAMPLES, "example-notes") } }, APP)) as { id: string; state: string; treeHash: string; card?: string };
      expect([r.id, r.state]).toEqual(["example-notes", "found"]);
      const card = broker.cards().find((c) => c.id === r.card);
      expect(card).toMatchObject({ kind: "plugin-ok", pluginId: "example-notes" });
      const text = cardText(card);
      expect(text).toContain("this tool only reads, so at the default approval level it runs without asking: list_notes");
      expect(text).toContain("this tool only changes its own display, so at the default level it runs without asking: add_note");
      expect(text).toContain("Its hooks run when its own bot's turns start, end or are compacted, and see no other bot");
      expect(text).toContain("Notes tidier");
      expect(text).not.toMatch(/network|still asks|notifications/i);
      expect(await opened.registry.approve(r.id, r.treeHash)).toBe("approved");
      const rec = opened.registry.get("example-notes");
      expect(rec?.state).toBe("running");
      expect(opened.registry.get("example-notes/bot")).toBeDefined();
      // The rule the pair teaches, from the registry's own predicates: here the two lists hold, and delete_note is on
      // neither (it asks). (`fenced`: the rule as a computer whose plugin fence holds.)
      expect(pluginToolContained(opened.registry, "example-notes", "notes", "add_note", { fenced: true })).toBe(true);
      expect(pluginToolReadOnly(opened.registry, "example-notes", "notes", "list_notes", { fenced: true })).toBe(true);
      expect(pluginToolContained(opened.registry, "example-notes", "notes", "delete_note", { fenced: true })).toBe(false);
      expect(pluginToolReadOnly(opened.registry, "example-notes", "notes", "delete_note", { fenced: true })).toBe(false);
      // Its hook's "sees no other bot" is the HOST's own-bot scope, not the example's code: with a second bot plugin in
      // the home, the host invokes the hook for Notes keeper's sessions (its conversation and a delegation of it) and
      // never for the other bot's, nor for a user's own coding session. The example's handler holds no check of its own.
      const other = (await m["plugin.install"]!({ source: { from: "folder", path: botPlugin("luna") } }, APP)) as { id: string; treeHash: string };
      expect(await opened.registry.approve(other.id, other.treeHash)).toBe("approved");
      expect(opened.registry.get("luna")?.state).toBe("running");
      const invoked: { pluginId: string; handler: string; bot?: string }[] = [];
      const hooks = pluginHooks({
        registry: opened.registry,
        host: { invoke: (async (req: InvokeRequest) => void invoked.push({ pluginId: req.pluginId, handler: req.handler, bot: (req.args as { bot?: string }).bot })) as never },
      });
      const as = (bot: string | undefined, kind: HookSession["kind"] = "bot"): HookSession => ({
        id: `s_${bot ?? "me"}_${kind}`, kind, computer: "Studio", ...(bot === undefined ? {} : { bot }),
        caller: { kind: "session", sessionId: `s_${bot ?? "me"}_${kind}`, sessionKind: kind, ...(bot === undefined ? {} : { bot }) } as Caller,
      });
      await hooks.turnEnd(as("luna"), "done", "completed");
      await hooks.turnEnd(as("luna", "agent"), "done", "completed");
      await hooks.turnEnd(as(undefined, "coding"), "done", "completed");
      expect(invoked).toEqual([]);
      await hooks.turnEnd(as("example-notes/bot"), "done", "completed");
      await hooks.turnEnd(as("example-notes/bot", "agent"), "done", "completed");
      expect(invoked.map((i) => [i.pluginId, i.handler, i.bot])).toEqual([["example-notes", "onTurnEnd", "example-notes/bot"], ["example-notes", "onTurnEnd", "example-notes/bot"]]);
      expect(readFileSync(join(EXAMPLES, "example-notes", "server", "index.ts"), "utf8")).not.toMatch(/args\??\.bot\s*!==/);
      // Its client, TSX importing React and the UI SDK, builds to the layer's imports only.
      const built = await buildPluginModule({ entry: join(home, "plugins", "example-notes", "client", "index.tsx"), outFile: join(temp("clover-d-ex-out-"), "index.js"), side: "client" });
      for (const spec of built.imports) expect([spec, (CLIENT_BARE_IMPORTS as readonly string[]).includes(spec)]).toEqual([spec, true]);
    } finally {
      opened.close();
    }
  });

  test("example-pngtuber: a third-party character renderer installs from its folder; its manifest holds the format it declares and its TSX builds to the layer's imports only", async () => {
    const home = temp("clover-d-pngtuber-");
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets: new MemorySecretStore(), settleMs: 50 });
    const m = pluginRegistryMethods({ opened, host: { restart: async () => {} }, home });
    try {
      const r = (await m["plugin.install"]!({ source: { from: "folder", path: join(EXAMPLES, "example-pngtuber") } }, APP)) as { id: string; treeHash: string };
      expect(await opened.registry.approve(r.id, r.treeHash)).toBe("approved");
      expect(opened.registry.get("example-pngtuber")?.state).toBe("running");
      // Its points (`avatar`, `avatar.formats`) are declared by the bundled character part, which a bare registry has not got: the
      // plugin waits for them, and the view's `avatarFormats` is tested against the part in ui.test.ts.
      expect(opened.registry.get("example-pngtuber")?.waitingFor).toEqual(["avatar", "avatar.formats"]);
      const built = await buildPluginModule({ entry: join(home, "plugins", "example-pngtuber", "client", "index.tsx"), outFile: join(temp("clover-d-pt-out-"), "index.js"), side: "client" });
      for (const spec of built.imports) expect([spec, (CLIENT_BARE_IMPORTS as readonly string[]).includes(spec)]).toEqual([spec, true]);
    } finally {
      opened.close();
    }
  });

  test("example-weather: installed and OK'd; its card names its host and notifications, and says its readOnly and contained tools still ask; the lists don't hold", async () => {
    const home = temp("clover-d-examples-w-");
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets: new MemorySecretStore(), settleMs: 50 });
    const m = pluginRegistryMethods({ opened, host: { restart: async () => {} }, home });
    try {
      const r = (await m["plugin.install"]!({ source: { from: "folder", path: join(EXAMPLES, "example-weather") } }, APP)) as { id: string; treeHash: string; card?: string };
      const text = cardText(broker.cards().find((c) => c.id === r.card));
      expect(text).toContain("api.example.com");
      expect(text).toContain("It sends you notifications");
      expect(text).toContain("Its server forecast says one tool only reads, but it can reach the network, so it still asks before running");
      expect(text).toContain("Its server forecast says one tool only changes its own display, but it can reach the network or do more than read Clover's state, so it still asks before running");
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
    expect(await n.countTurn()).toBe(1);
    expect(await n.countTurn()).toBe(2);
    expect(readNotes([{ id: "n1", text: "ok", at: 1 }, { id: 2 }, "junk", null])).toEqual([{ id: "n1", text: "ok", at: 1 }]);
  });

  test("Notes keeper's window skin passes Clover's own marks in both appearances (a group that fails is dropped, and the window isn't skinned)", () => {
    const theme = JSON.parse(readFileSync(join(EXAMPLES, "example-notes", "plugins", "bot", "theme", "theme.json"), "utf8")) as { shell: never; tokens: Record<string, string>; dark: { tokens: Record<string, string> } };
    for (const [mode, ground] of [["light", theme.tokens["color.canvas"]!], ["dark", theme.dark.tokens["color.canvas"]!], ["light", "#FFFFFF"], ["dark", "#191919"]] as const) {
      expect([mode, ground, resolveShell(theme.shell, mode, ground).dropped]).toEqual([mode, ground, []]);
    }
  });

  test("the host half: its tools, the hook (own bot only) and the command, over a fake store", async () => {
    const s = store();
    const host = await import("../../../../plugin-sdk/examples/example-notes/server/index");
    host.start({ plugin: { id: "example-notes" }, storage: { synced: s } } as never);
    expect(await host.note({ text: "From the slash menu" })).toEqual({ text: "Noted: From the slash menu" });
    await host.onTurnEnd({ bot: "example-notes/bot" });
    expect(await host.ui!.list!(undefined, {} as never)).toMatchObject({ notes: [{ text: "From the slash menu" }], turns: 1 });
    expect(JSON.parse(readFileSync(join(EXAMPLES, "example-notes", "clover.json"), "utf8")).contributes.hooks[0].scope).toBe("own-bot");
    host.stop();
  });
});
