// A second name for another bot's record or instructions, made by a bot's own shell under its REAL sandbox (lane BT,
// read 65's S1). A bot reads the whole MOSS home and writes inside every bot's `memory/` and inside its own and its
// made bots' `instructions/`; `bots/*/bot.json` and `bots/*/instructions/*` are kept from it by the home's default-deny
// by name only. This drives one Bash turn through the embedded runtime with the sandbox MOSS draws for Alpha
// (`botSandboxSettings` over the fence's policy for her conversation), on a temp home with dummy files, and records
// for each `ln` whether the link was made. macOS only, like the neighbouring e2e tests.
//
// Run only: scripts/pinned-bun test packages/core/test/runtime-sdk/turn-loop/bot-hardlinks.e2e.test.ts
import { afterAll, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnControl, TurnInput } from "../../../src/contracts/session-host";
import type { BotSessionContext, EffectiveBot } from "../../../src/bots/service";
import { botPaths } from "../../../src/bots/paths";
import { BotSessionDriver, type BotDriverDeps } from "../../../src/runtime-sdk/turn-loop/driver";
import { MossFence } from "../../../src/fence/fence";
import { botSandboxSettings } from "../../../src/fence/sandbox-settings";
import { describeWithEmbeddedRuntime } from "../../helpers/embedded-runtime";
import { darwinTest } from "../../helpers/darwin-only";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

function control(): TurnControl {
  const ac = new AbortController();
  return { origin: "user", signal: ac.signal, onFold: () => () => {}, record: () => {} } as unknown as TurnControl;
}

function context(home: string): BotSessionContext {
  const bot: EffectiveBot = { id: "alpha", name: "Alpha", instructions: "You are Alpha.", model: "winter-test/calls", modelFrom: "user", userLayer: [] };
  return {
    botId: "alpha", sessionId: "b_alpha", kind: "bot", computer: "Studio", paths: botPaths(home, "alpha"),
    caller: { kind: "session", sessionId: "b_alpha", sessionKind: "bot", bot: "alpha" },
    current: () => bot, memoryBlock: () => "<memory>\nnothing yet\n</memory>",
    mayAct: () => true, whenMayAct: async () => {}, cacheCold: () => false,
  };
}

const user = (text: string): TurnInput => ({ from: "user", text, device: "d_1", sentAt: Date.now(), clientMessageId: crypto.randomUUID() });

describeWithEmbeddedRuntime("a bot's shell and another bot's record: no second name", (spawn) => {
  darwinTest("ln of luna's bot.json or instructions into a folder Alpha writes is refused under her real sandbox", async () => {
    const userDir = realpathSync(mkdtempSync(join(tmpdir(), "moss-bt-links-")));
    temps.push(userDir);
    const home = join(userDir, ".moss");
    const t = join(userDir, "t");
    mkdirSync(t, { recursive: true });
    const record = (id: string, madeBy: object) => {
      const dir = join(home, "bots", id);
      mkdirSync(join(dir, "instructions"), { recursive: true });
      mkdirSync(join(dir, "memory"), { recursive: true });
      writeFileSync(join(dir, "bot.json"), JSON.stringify({ record: 1, id, name: id, madeBy, createdAt: 1 }));
      writeFileSync(join(dir, "instructions", "instructions.md"), `PROBE_SECRET=dummy-${id}`);
    };
    record("alpha", { kind: "user" });
    record("luna", { kind: "user" });
    const ctx = context(home);
    mkdirSync(ctx.paths.scratch, { recursive: true });
    const fence = new MossFence({ home: userDir, mossHome: home, temp: t });
    const sandbox = (c: BotSessionContext) => botSandboxSettings(fence.forCaller(c.caller).policy(), {
      mossHome: home, userHome: userDir, level: "ask-risky", ownFolders: [c.paths.scratch, c.paths.root], pathFolders: [],
    });
    const deps: BotDriverDeps = {
      home, spawn, sandbox, stopGraceMs: 5_000,
      canUseTool: () => async (_n, input) => ({ behavior: "allow", updatedInput: input as Record<string, unknown> }),
      log: () => {},
    };
    const driver = new BotSessionDriver(ctx, deps);
    const L = (s: string) => join(home, "bots", "luna", s);
    const A = (s: string) => join(home, "bots", "alpha", s);
    const S = (s: string) => join(ctx.paths.scratch, s);
    const probes: [string, string, string][] = [
      ["luna-record-to-alpha-memory", L("bot.json"), A("memory/l.json")],
      ["luna-record-to-alpha-instructions", L("bot.json"), A("instructions/l.json")],
      ["luna-record-to-own-scratch", L("bot.json"), S("l.json")],
      ["luna-instructions-to-alpha-memory", L("instructions/instructions.md"), A("memory/l.md")],
      ["luna-instructions-to-own-scratch", L("instructions/instructions.md"), S("l.md")],
      ["luna-record-to-luna-memory", L("bot.json"), L("memory/l.json")],
      ["own-record-to-own-scratch", A("bot.json"), S("a.json")],
    ];
    const res = join(t, "res");
    const script = [`R=${JSON.stringify(res)}`, `printf ok > ${JSON.stringify(S("control.txt"))}; echo "control=$?" >> "$R"`,
      // A link inside its own scratch is made: `ln` itself works, so a refusal below is the sandbox's.
      `ln ${JSON.stringify(S("control.txt"))} ${JSON.stringify(S("control-link.txt"))}; echo "control-link=$?" >> "$R"`,
      ...probes.map(([name, from, to]) => `ln ${JSON.stringify(from)} ${JSON.stringify(to)} 2>/dev/null; echo "${name}=$?" >> "$R"`)].join("\n");
    try {
      const end = await driver.turn(user(`CALL Bash ${JSON.stringify({ command: script, description: "probe hard links" })}`), control());
      expect(end.reason).toBe("end_turn");
    } finally {
      await driver.stop();
    }
    const exits = Object.fromEntries(readFileSync(res, "utf8").trim().split("\n").map((l) => l.split("=") as [string, string]));
    const linked = Object.fromEntries(probes.map(([name, from]) => [name, statSync(from).nlink > 1]));
    // Printed for the report: which `ln` exited 0, and whether the source then had a second name.
    console.error(`[bt-hardlinks] exits ${JSON.stringify(exits)} linked ${JSON.stringify(linked)}`);
    expect(exits["control"]).toBe("0"); // the shell writes its own scratch: the sandbox isn't simply refusing all
    expect([exits["control-link"], statSync(S("control.txt")).nlink]).toEqual(["0", 2]);
    for (const [name] of probes) expect({ name, linked: linked[name] }).toEqual({ name, linked: false });
  }, 120_000);
});
