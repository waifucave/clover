// A bot's own plugin stopped by the crash rules tells that bot, once per stop, in its conversation, starting a turn:
// over the real plugin registry and the real plugin host (its process, its worker, a fake clock for the backoff), into
// a real session host's bot conversation (a fake driver for the turn). A plugin the user installed tells no bot, nor
// does the user's own stop; the user's restart and a second crash-stop tell the bot again. Temp home, the fake approval
// broker and an in-memory secret store; nothing opens a window.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import { openPluginRegistry } from "../../registry/open";
import { DurableSessionHost } from "../../sessions/durable-host";
import { projectRecords } from "../../sessions/wire";
import { crashNotices, crashNoticeText } from "../crash-notice";
import { startPluginHost } from "../daemon-host";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const USER: Caller = { kind: "user", client: "app" };
const REEL_REASON = "crashed 3 times in 10 minutes: start failed: the timeline file is missing";

function plugin(home: string, id: string, name: string, startThrows: boolean): void {
  const folder = join(home, "plugins", id);
  mkdirSync(join(folder, "host"), { recursive: true });
  writeFileSync(join(folder, "clover.json"), JSON.stringify({ manifest: 1, id, name, version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js" } }));
  writeFileSync(join(folder, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(folder, "host", "index.js"), startThrows
    ? "export async function start() { throw new Error(\"the timeline file is missing\"); }\nexport const ping = async () => \"pong\";\n"
    : "export const ping = async () => \"pong\";\n");
}

async function until<T>(what: string, ms: number, f: () => T | undefined): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`);
    await Bun.sleep(10);
  }
}

describe("a bot's plugin stopped by the crash rules", () => {
  test("its builder is told once per stop, in its conversation, and the message starts a turn; the user's plugins and stops tell no one", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-b-crash-notice-")));
    temps.push(home);
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 60_000 });
    // Put in place after the registry opened, as PluginInstall does, so each is read with who installed it.
    plugin(home, "reel", "Reel", true);
    plugin(home, "users-reel", "User's reel", true);
    plugin(home, "steady", "Steady", false);
    const clock = new FakeClock({ start: Date.now() });
    const lines: string[] = [];
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, clock, log: (l) => lines.push(l) });

    // Alpha's conversation in a real session host; the bot side's door (`BotService.deliverTo`) is its main session's
    // `deliver`.
    const sessions = new DurableSessionHost({ home, clock });
    const driver = new FakeSessionDriver();
    sessions.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, driver);
    const delivered: { bot: string; disposition: string }[] = [];
    const stop = crashNotices({
      host: ph.host, registry: opened.registry, log: (l) => lines.push(l),
      bots: () => ({
        has: (id) => id === "alpha",
        deliverTo: async (id, input) => {
          const r = await sessions.deliver("b_alpha", input);
          delivered.push({ bot: id, disposition: r.disposition });
          return r;
        },
      }),
    });
    const ok = async (id: string, by: "bot" | "app") => {
      if (by === "bot") await opened.folders.installed(id, "bot", { bot: "alpha" });
      else await opened.folders.installed(id, "user-app");
      const { card } = await opened.registry.installed(id, by);
      const shown = broker.cards().find((c) => c.id === card)!;
      await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
      await until(`${id} running after its OK`, 10_000, () => (opened.registry.get(id)?.state === "running" ? true : undefined));
    };
    /** Starts it, and lets the crash rules run their backoffs until it is stopped. */
    const crashToStop = async (id: string) => {
      void ph.host.ensureStarted(id).catch(() => {});
      await until(`${id} stopped by the crash rules`, 20_000, () => {
        clock.advance(60_000);
        return ph.host.status(id).state === "stopped" ? true : undefined;
      });
      await flush();
    };
    try {
      await ok("reel", "bot");
      await ok("users-reel", "app");
      await ok("steady", "bot");

      // The bot's plugin crashes at start three times and stops: its builder hears of it once, starting a turn.
      await crashToStop("reel");
      expect(ph.host.status("reel")).toMatchObject({ state: "stopped", reason: REEL_REASON });
      await until("the notice delivered", 5_000, () => (delivered.length === 1 ? true : undefined));
      expect(delivered).toEqual([{ bot: "alpha", disposition: "turn" }]);
      const text = crashNoticeText("Reel", "reel", REEL_REASON);
      expect(text).toBe("Reel stopped: crashed 3 times in 10 minutes: start failed: the timeline file is missing. PluginStatus reel has the log.");
      await until("the bot's turn", 5_000, () => (driver.turns.length === 1 ? true : undefined));
      expect(driver.turns[0]).toMatchObject({ input: { from: "notice", label: "Plugin stopped", text }, origin: "plugin" });
      // On the wire, the core's note, in a turn of its own.
      const wire = projectRecords(sessions.history("b_alpha"), { sessionId: "b_alpha" } as never) as { type: string; from?: unknown; label?: string; text?: string }[];
      expect(wire.find((e) => e.type === "note")).toMatchObject({ from: { kind: "core" }, label: "Plugin stopped", text });
      expect(wire.some((e) => e.type === "turn_started")).toBe(true);
      expect(lines.some((l) => l.includes("reel stopped; told its builder alpha (turn)"))).toBe(true);

      // A plugin the user installed tells no bot; nor does the user's stop of the bot's working plugin.
      await crashToStop("users-reel");
      await ph.host.invoke({ pluginId: "steady", handler: "ping", args: null, caller: USER });
      await ph.host.stop("steady", "the user stopped it");
      await flush();
      expect(delivered.length).toBe(1);

      // The user restarts the bot's plugin; it crashes to a stop again: one more message, not more.
      // (Not awaited: the restart waits for a start the fake clock's backoffs hold until `crashToStop` moves them.)
      void ph.host.restart("reel").catch(() => {});
      await until("reel restarted", 5_000, () => (ph.host.status("reel").state !== "stopped" ? true : undefined));
      await crashToStop("reel");
      await until("the second notice", 5_000, () => (delivered.length === 2 ? true : undefined));
      await flush();
      expect(delivered.length).toBe(2);
    } finally {
      stop();
      await ph.close();
    }
  }, 60_000);
});
