// The drop end to end (the owner's ask on try 14c): a bot builds a plugin in its scratch and moves it into the plugins
// folder with its shell; Clover indexes it once it settles and asks the OK at once, naming the bot; after the OK the bot
// edits it in place with no card. Through the real embedded runtime (the scripted model), the real registry watching the
// plugins folder, the real fence following its records, the bot's sandbox as the daemon draws it, and the Worker's host
// protection as the daemon's embedded host draws it. Every other plugin stays refused to the bot, its plugin to another
// bot, and a folder a background command makes after the shell call returned is nobody's: an ordinary found plugin.
import { afterAll, expect, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLUGIN_API_VERSION, catalogPointDecl } from "@waifucave/clover-plugin-sdk";
import type { TurnControl, TurnInput } from "../../../src/contracts/session-host";
import type { BotSessionContext, EffectiveBot } from "../../../src/bots/service";
import { botPaths } from "../../../src/bots/paths";
import { BotSessionDriver, botFileFence, type BotDriverDeps } from "../../../src/runtime-sdk/turn-loop/driver";
import { CloverFence } from "../../../src/fence/fence";
import { botSandboxSettings } from "../../../src/fence/sandbox-settings";
import { createEmbeddedSessionHost, EMBEDDED_SHUTDOWN_BUDGET_MS, type EmbeddedSessionHost } from "../../../src/runtime-sdk/embedded";
import { RegistryCore, type OkCardRaiser } from "../../../src/registry/core";
import { PluginFolders } from "../../../src/registry/folders";
import { fileRegistryStore } from "../../../src/registry/state";
import { darwinTest } from "../../helpers/darwin-only";

setDefaultTimeout(120_000);
const temps: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const control = (): TurnControl => ({ origin: "user", signal: new AbortController().signal, onFold: () => () => {}, record: () => {} }) as unknown as TurnControl;
const user = (text: string): TurnInput => ({ from: "user", text, device: "d_1", sentAt: Date.now(), clientMessageId: crypto.randomUUID() });
const results = (end: { text?: string }) => JSON.parse(end.text ?? "[]") as { name: string | null; isError: boolean; content: string }[];
const manifest = (id: string) => JSON.stringify({ manifest: 1, id, name: id, version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` } });
/** Until `cond` holds: a bounded wait on the outcome, generous for a loaded machine (the watch can drop an event; the
 *  registry's catch-up look reads the change anyway, within its interval). */
async function until(cond: () => boolean, what: string, ms = 30_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) if (cond()) return;
  throw new Error(`never: ${what}`);
}

function context(cloverHome: string, bot: string): BotSessionContext & { bot: EffectiveBot } {
  const b: EffectiveBot = { id: bot, name: bot, instructions: `You are ${bot}.`, model: "winter-test/calls", modelFrom: "user", userLayer: [] };
  return {
    bot: b, botId: bot, sessionId: `b_${bot}`, kind: "bot", computer: "Studio", paths: botPaths(cloverHome, bot),
    caller: { kind: "session", sessionId: `b_${bot}`, sessionKind: "bot", bot },
    current: () => b, memoryBlock: () => "<memory>\nnothing yet\n</memory>", mayAct: () => true, whenMayAct: async () => {}, cacheCold: () => false,
  };
}

darwinTest("a bot moves its plugin in with its shell: found, its card names it, nothing runs; after the OK it edits it in place; nothing else opens", async () => {
  const userHome = realpathSync(mkdtempSync(join(tmpdir(), "clover-a-drop-e2e-")));
  temps.push(userHome);
  const cloverHome = join(userHome, ".clover");
  const pluginsDir = join(cloverHome, "plugins");
  // Another plugin already there (the user's), and Alpha's plugin built in her scratch.
  mkdirSync(join(pluginsDir, "fish-audio"), { recursive: true });
  writeFileSync(join(pluginsDir, "fish-audio", "clover.json"), manifest("fish-audio"));
  const scratch = botPaths(cloverHome, "alpha").scratch;
  mkdirSync(join(scratch, "ws-greeter", "host"), { recursive: true });
  writeFileSync(join(scratch, "ws-greeter", "clover.json"), manifest("ws-greeter"));
  writeFileSync(join(scratch, "ws-greeter", "host", "index.ts"), "export const hello = 1;\n");
  mkdirSync(botPaths(cloverHome, "luna").scratch, { recursive: true });

  // The registry, watching the plugins folder, with the cards it raises.
  const raised: { id: string; card: string; treeHash: string; answered: (a: { approved: boolean }) => void }[] = [];
  const cards: OkCardRaiser = { raise: (req, answered) => { const card = `card_${raised.length + 1}`; raised.push({ id: req.id, card, treeHash: req.treeHash, answered }); return card; } };
  const store = fileRegistryStore(join(cloverHome, "plugins-state"));
  let folders!: PluginFolders;
  const core = new RegistryCore({ catalog: catalogPointDecl, store, cards, onOk: (id, hash) => folders.okGiven(id, hash) });
  folders = new PluginFolders({ core, store, pluginsDir, settleMs: 300, catchUpMs: 500 });
  folders.setBotNames((id) => (id === "alpha" ? "Alpha" : undefined));
  await folders.scan();
  folders.start();
  closers.push(() => folders.stop());
  // The fence follows the records and the bots' pending drops; the embedded host opens the bots' plugins.
  const fence = new CloverFence({ home: userHome, cloverHome });
  closers.push(fence.followWorkshop(core, { pending: (bot) => folders.pendingDrops(bot) }));
  const workshopFolders = () => [...core.list().filter((r) => r.provenance.by === "bot").map((r) => r.folder), ...folders.pendingDrops().map((n) => join(pluginsDir, n))];
  const host: EmbeddedSessionHost = createEmbeddedSessionHost({ home: cloverHome, workshopFolders });
  closers.push(() => host.shutdown(EMBEDDED_SHUTDOWN_BUDGET_MS));
  const allow: BotDriverDeps["canUseTool"] = () => async (_n, input) => ({ behavior: "allow", updatedInput: input as Record<string, unknown> });
  const driverFor = (bot: string) => {
    const d = new BotSessionDriver(context(cloverHome, bot), {
      home: cloverHome, spawn: (o) => host.spawn(o), canUseTool: allow, stopGraceMs: 5_000, log: () => {},
      sandbox: (ctx) => botSandboxSettings(fence.forCaller(ctx.caller).policy(), { cloverHome: fence.cloverHome, userHome: fence.home, level: undefined, ownFolders: [ctx.paths.scratch, ctx.paths.root], pathFolders: [] }),
      fileFence: botFileFence(fence, fence.cloverHome, "macos", userHome),
      pluginDrops: { folder: pluginsDir, dropped: (name, b) => void folders.dropped(name, b) },
    });
    closers.push(() => d.stop());
    return d;
  };
  const alpha = driverFor("alpha");
  const luna = driverFor("luna");
  const real = (p: string) => realpathSync(p);

  // 1. Alpha's shell moves it in.
  const mv = await alpha.turn(user(`CALL Bash ${JSON.stringify({ command: `mv ${JSON.stringify(join(scratch, "ws-greeter"))} ${JSON.stringify(pluginsDir)}/`, description: "install by moving" })}`), control());
  expect(results(mv).find((r) => r.name === "Bash")?.content ?? "").not.toContain("Operation not permitted");
  expect(existsSync(join(pluginsDir, "ws-greeter", "clover.json"))).toBe(true);
  await until(() => raised.some((r) => r.id === "ws-greeter"), "ws-greeter's card");
  expect(core.get("ws-greeter")).toMatchObject({ state: "found", provenance: { by: "bot", bot: "alpha" } });
  expect(folders.okText("ws-greeter", "macos").source).toContain("Built by Alpha");

  // 2. The user's OK: it's Alpha's to edit in place.
  raised.find((r) => r.id === "ws-greeter")!.answered({ approved: true });
  await until(() => core.get("ws-greeter")?.state !== "found", "ws-greeter approved");
  const file = join(pluginsDir, "ws-greeter", "host", "index.ts");
  const edit = await alpha.turn(user(`CALL Read ${JSON.stringify({ file_path: file })}\nCALL Edit ${JSON.stringify({ file_path: file, old_string: "hello = 1", new_string: "hello = 2" })}`), control());
  expect(results(edit).find((r) => r.name === "Edit")?.isError).toBe(false);
  expect(readFileSync(file, "utf8")).toContain("hello = 2");

  // 3. Nothing else opens: another plugin to Alpha (file tools and shell), Alpha's plugin to Luna.
  const other = await alpha.turn(user([
    `CALL Write ${JSON.stringify({ file_path: join(pluginsDir, "fish-audio", "evil.ts"), content: "x" })}`,
    `CALL Bash ${JSON.stringify({ command: `printf x > ${JSON.stringify(join(pluginsDir, "fish-audio", "evil2.ts"))}; echo done`, description: "probe" })}`,
  ].join("\n")), control());
  expect(results(other).find((r) => r.name === "Write")?.content ?? "").not.toContain("File created");
  expect(existsSync(join(pluginsDir, "fish-audio", "evil.ts"))).toBe(false);
  expect(existsSync(join(pluginsDir, "fish-audio", "evil2.ts"))).toBe(false);
  const lunaTry = await luna.turn(user([
    `CALL Write ${JSON.stringify({ file_path: join(pluginsDir, "ws-greeter", "host", "luna.ts"), content: "x" })}`,
    `CALL Bash ${JSON.stringify({ command: `printf x > ${JSON.stringify(join(pluginsDir, "ws-greeter", "luna2.ts"))}; echo done`, description: "probe" })}`,
  ].join("\n")), control());
  expect(results(lunaTry).some((r) => r.name === "Write")).toBe(true);
  expect(existsSync(join(pluginsDir, "ws-greeter", "host", "luna.ts"))).toBe(false);
  expect(existsSync(join(pluginsDir, "ws-greeter", "luna2.ts"))).toBe(false);

  // 4. A background command that makes a folder after its call returned: nobody's, the ordinary found card.
  mkdirSync(join(scratch, "late-tool"), { recursive: true });
  writeFileSync(join(scratch, "late-tool", "clover.json"), manifest("late-tool"));
  await alpha.turn(user(`CALL Bash ${JSON.stringify({ command: `(sleep 2; mv ${JSON.stringify(join(scratch, "late-tool"))} ${JSON.stringify(pluginsDir)}/) > /dev/null 2>&1 &`, description: "later" })}`), control());
  await until(() => raised.some((r) => r.id === "late-tool"), "late-tool's card");
  expect(core.get("late-tool")!.provenance).toMatchObject({ by: "found" });
  expect(real(dirname(file))).toBe(join(real(pluginsDir), "ws-greeter", "host"));
});
