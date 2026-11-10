// The macOS end-to-end audit's HIGH finding: one bot turn made a home un-bootable. The embedded runtime ran with
// `CLOVER_HOME` on the Clover home itself, so it wrote its transcript in the OLD layout (`<home>/projects/...`), which
// the next boot read as a home Migration C hadn't run on: a non-default home refused to boot ("migration C … old
// layout", daemon.ts), and the default home would migrate again at every boot. The core also looks for the transcript
// in the store home (`<home>/sdk`), so a restart never resumed it.
//
// Here, on a build whose router applies run homes: a daemon boots on a temp (non-default) home and stops; a bot turn
// runs on that home through the same embedded seam the daemon's bots use; the daemon boots again, clean, with
// Migration C neither refused nor run; and a restarted bot session resumes its transcript.
import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query as sdkQuery } from "@waifucave/clover-agent-sdk";
import type { TurnControl, TurnInput } from "../src/contracts/session-host";
import type { BotSessionContext, EffectiveBot } from "../src/bots/service";
import { botPaths } from "../src/bots/paths";
import { FileSecretStore } from "../src/auth/secret-store";
import { startDaemon, type RunningDaemon } from "../src/daemon";
import { isOldLayout, migrationCManifestPath } from "../src/migration/migrate-c";
import { setRunHomeSupportForTests } from "../src/runtime-sdk/run-home-support";
import { storeProjectsDir } from "../src/agent/paths";
import { BotSessionDriver } from "../src/runtime-sdk/turn-loop/driver";
import { describeWithEmbeddedRuntime } from "./helpers/embedded-runtime";

const temps: string[] = [];
let daemon: RunningDaemon | undefined;
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  setRunHomeSupportForTests(undefined);
});
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

function control(): TurnControl {
  return { origin: "user", signal: new AbortController().signal, onFold: () => () => {}, record: () => {} };
}

const user = (text: string): TurnInput => ({ from: "user", text, device: "d_1", sentAt: Date.now(), clientMessageId: crypto.randomUUID() });

function context(home: string): BotSessionContext {
  const bot: EffectiveBot = { id: "luna", name: "Luna", instructions: "You are Luna.", model: "winter-test/echo", userLayer: [] };
  return {
    botId: "luna", sessionId: "b_luna", kind: "bot", computer: "Studio", paths: botPaths(home, "luna"),
    caller: { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "luna" },
    current: () => bot,
    memoryBlock: () => "<memory>\nnothing yet\n</memory>",
    mayAct: () => true,
    whenMayAct: async () => {},
    cacheCold: () => false,
  } as unknown as BotSessionContext;
}

describeWithEmbeddedRuntime("a bot turn keeps the home in the new layout", (spawn) => {
  test("boot, one bot turn, restart: the daemon boots clean, Migration C neither refuses nor runs, and the session resumes", async () => {
    setRunHomeSupportForTests(true);
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "clover-a3-layout-")));
    temps.push(parent);
    // Not the profile's default home: an old-layout home here refuses to boot.
    const home = join(parent, "server-home");
    const boot = () => startDaemon({
      home,
      secrets: new FileSecretStore(join(parent, "secrets")),
      migration: { legacyHome: join(parent, "no-legacy-home"), homedirOverride: () => join(parent, "elsewhere") },
      agentProvider: null,
    });
    daemon = await boot();
    await daemon.stop();
    daemon = undefined;

    // One bot turn on that home, through the daemon's embedded seam.
    const opened: { resume?: string; sessionId?: string }[] = [];
    const query: typeof sdkQuery = (args) => {
      const o = args.options as { resume?: string; sessionId?: string; env?: Record<string, string> };
      opened.push({ ...(o.resume === undefined ? {} : { resume: o.resume }), ...(o.sessionId === undefined ? {} : { sessionId: o.sessionId }) });
      // The runtime's home is the store home, never the Clover home.
      expect(o.env?.CLOVER_HOME).toBe(join(home, "sdk"));
      return sdkQuery(args);
    };
    const deps = { home, spawn, query, canUseTool: () => async (_n: string, input: unknown) => ({ behavior: "allow" as const, updatedInput: input as Record<string, unknown> }), sandbox: () => ({ enabled: false }), stopGraceMs: 5_000, log: () => {} };
    const first = new BotSessionDriver(context(home), deps as never);
    try {
      expect((await first.turn(user("hello"), control())).reason).toBe("end_turn");
    } finally {
      await first.stop();
    }
    // Nothing in the old layout; the transcript is in the store.
    expect(existsSync(join(home, "projects"))).toBe(false);
    expect(isOldLayout(home)).toBe(false);
    const store = storeProjectsDir(home);
    expect(readdirSync(store, { recursive: true }).some((f) => String(f).endsWith(".jsonl"))).toBe(true);

    // The restart boots clean: no refusal, and Migration C didn't run (it leaves its manifest when it does).
    daemon = await boot();
    expect(existsSync(migrationCManifestPath(home))).toBe(false);
    await daemon.stop();
    daemon = undefined;

    // A restarted bot session finds its transcript and resumes it.
    const again = new BotSessionDriver(context(home), deps as never);
    try {
      const end = await again.turn(user("second"), control());
      expect(end.reason).toBe("end_turn");
    } finally {
      await again.stop();
    }
    expect(opened).toHaveLength(2);
    expect(opened[0]!.resume).toBeUndefined();
    expect(opened[1]!.resume).toBe(opened[0]!.sessionId);
  }, 120_000);
});
