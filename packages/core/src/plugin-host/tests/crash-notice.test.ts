// A bot's own plugin stopped by the crash rules tells that bot, once per stop, in its conversation, starting a turn;
// the bot's fixing edit starts it again; a still-broken edit is told again; the third stop in an hour says it is the last
// notice until the user restarts it. A child of a bot's plugin is named by its own id, whose log `PluginStatus` shows.
// Over the real plugin registry and the real plugin host (its process, its worker, a fake clock for the backoff), into
// a real session host's bot conversation (a fake driver for the turn). A plugin the user installed tells no bot, nor
// does the user's own stop. Temp home, the fake approval broker and an in-memory secret store; nothing opens a window.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PLUGIN_API_VERSION } from "@waifucave/clover-plugin-sdk";
import type { Caller } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import { openPluginRegistry } from "../../registry/open";
import { PluginWorkshop } from "../../registry/workshop";
import { DurableSessionHost } from "../../sessions/durable-host";
import { projectRecords } from "../../sessions/wire";
import { crashNotices, crashNoticeText } from "../crash-notice";
import { startPluginHost } from "../daemon-host";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const USER: Caller = { kind: "user", client: "app" };
const THROWS = (why: string) => `export async function start() { console.log("starting"); throw new Error(${JSON.stringify(why)}); }\nexport const ping = async () => "pong";\n`;
const WORKS = (answer: string) => `export const ping = async () => ${JSON.stringify(answer)};\n`;
const reason = (why: string) => `crashed 3 times in 10 minutes: start failed: ${why}`;

function write(dir: string, files: Record<string, string>): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
}
const manifest = (id: string, name: string, host = true) => JSON.stringify({ manifest: 1, id, name, version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, ...(host ? { host: { entry: "host/index.js" } } : {}) });

async function until<T>(what: string, ms: number, f: () => T | undefined): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`);
    await Bun.sleep(10);
  }
}

/** A temp home with the real registry, the real plugin host on a fake clock, Alpha's conversation in a real session
 *  host (the bot side's door, `BotService.deliverTo`, is its main session's `deliver`), and the notices. */
async function world(prefix: string) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(home);
  const broker = new FakeApprovalBroker({ clock: new FakeClock() });
  const secrets = new MemorySecretStore();
  const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 60_000 });
  const clock = new FakeClock({ start: Date.now() });
  const lines: string[] = [];
  const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, clock, log: (l) => lines.push(l) });
  const sessions = new DurableSessionHost({ home, clock });
  const driver = new FakeSessionDriver();
  sessions.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, driver);
  const delivered: { bot: string; disposition: string; text: string }[] = [];
  const notices = crashNotices({
    host: ph.host, registry: opened.registry, log: (l) => lines.push(l), now: () => clock.now(),
    bots: () => ({
      has: (id) => id === "alpha",
      deliverTo: async (id, input) => {
        const r = await sessions.deliver("b_alpha", input);
        delivered.push({ bot: id, disposition: r.disposition, text: (input as { text: string }).text });
        return r;
      },
    }),
  });
  /** Puts a plugin in place as PluginInstall does (after the registry opened, so it is read with who installed it),
   *  and OKs it. */
  const install = async (id: string, files: Record<string, string>, by: "bot" | "app") => {
    write(join(home, "plugins", id), files);
    if (by === "bot") await opened.folders.installed(id, "bot", { bot: "alpha" });
    else await opened.folders.installed(id, "user-app");
    const { card } = await opened.registry.installed(id, by);
    const shown = broker.cards().find((c) => c.id === card)!;
    await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
    await until(`${id} running after its OK`, 30_000, () => (opened.registry.get(id)?.state === "running" ? true : undefined));
  };
  /** Starts it (unless something already is), and lets the crash rules run their backoffs until it is stopped. */
  const crashToStop = async (id: string) => {
    void ph.host.ensureStarted(id).catch(() => {});
    await until(`${id} stopped by the crash rules`, 60_000, () => {
      const s = ph.host.status(id);
      if (s.state === "stopped") return true;
      // Only the backoff the host waits on moves the clock, to the moment it restarts: the fake time between stops is the
      // crash rules' own, never the number of polls a slow start took (on a loaded machine 60 s a poll put the third stop
      // more than an hour after the first, and the cap never came).
      if (s.state === "restarting" && s.restartAt !== undefined && s.restartAt > clock.now()) clock.advance(s.restartAt - clock.now());
      return undefined;
    });
    await flush();
  };
  /** The builder edits its plugin in place (the workshop rule): no card for code that asks for nothing new. */
  const edit = async (id: string, path: string, body: string) => {
    const hash = opened.registry.get(id)!.treeHash;
    write(join(home, "plugins", id), { [path]: body });
    await opened.folders.refresh(join(home, "plugins", id));
    await until(`${id}'s edit applied`, 30_000, () => {
      const r = opened.registry.get(id)!;
      return r.treeHash !== hash && r.okHash === r.treeHash ? true : undefined;
    });
  };
  return { home, broker, opened, clock, lines, ph, sessions, driver, delivered, notices, install, crashToStop, edit };
}

describe("a bot's plugin stopped by the crash rules", () => {
  test("its builder is told once per stop, in its conversation, and the message starts a turn; the user's plugins and stops tell no one", async () => {
    const w = await world("clover-b-crash-notice-");
    try {
      await w.install("reel", { "clover.json": manifest("reel", "Reel"), "package.json": "{\"type\":\"module\"}", "host/index.js": THROWS("the timeline file is missing") }, "bot");
      await w.install("users-reel", { "clover.json": manifest("users-reel", "User's reel"), "package.json": "{\"type\":\"module\"}", "host/index.js": THROWS("the timeline file is missing") }, "app");
      await w.install("steady", { "clover.json": manifest("steady", "Steady"), "package.json": "{\"type\":\"module\"}", "host/index.js": WORKS("pong") }, "bot");

      // The bot's plugin crashes at start three times and stops: its builder hears of it once, starting a turn.
      await w.crashToStop("reel");
      expect(w.ph.host.status("reel")).toMatchObject({ state: "stopped", reason: reason("the timeline file is missing") });
      await until("the notice delivered", 20_000, () => (w.delivered.length === 1 ? true : undefined));
      const text = crashNoticeText("Reel", "reel", reason("the timeline file is missing"));
      expect(text).toBe("Reel stopped: crashed 3 times in 10 minutes: start failed: the timeline file is missing. PluginStatus reel has the log.");
      expect(w.delivered).toEqual([{ bot: "alpha", disposition: "turn", text }]);
      await until("the bot's turn", 20_000, () => (w.driver.turns.length === 1 ? true : undefined));
      expect(w.driver.turns[0]).toMatchObject({ input: { from: "notice", label: "Plugin stopped", text }, origin: "plugin" });
      // On the wire, the core's note, in a turn of its own.
      const wire = projectRecords(w.sessions.history("b_alpha"), { sessionId: "b_alpha" } as never) as { type: string; from?: unknown; label?: string; text?: string }[];
      expect(wire.find((e) => e.type === "note")).toMatchObject({ from: { kind: "core" }, label: "Plugin stopped", text });
      expect(wire.some((e) => e.type === "turn_started")).toBe(true);
      expect(w.lines.some((l) => l.includes("reel stopped; told its builder alpha (turn)"))).toBe(true);

      // A plugin the user installed tells no bot; nor does the user's stop of the bot's working plugin.
      await w.crashToStop("users-reel");
      await w.ph.host.invoke({ pluginId: "steady", handler: "ping", args: null, caller: USER });
      await w.ph.host.stop("steady", "the user stopped it");
      await flush();
      expect(w.delivered.length).toBe(1);

      // The user restarts the bot's plugin; it crashes to a stop again: one more message, not more.
      // (Not awaited: the restart waits for a start the fake clock's backoffs hold until `crashToStop` moves them.)
      w.notices.userRestarted("reel");
      void w.ph.host.restart("reel").catch(() => {});
      await until("reel restarted", 20_000, () => (w.ph.host.status("reel").state !== "stopped" ? true : undefined));
      await w.crashToStop("reel");
      await until("the second notice", 20_000, () => (w.delivered.length === 2 ? true : undefined));
      await flush();
      expect(w.delivered.length).toBe(2);
    } finally {
      w.notices.stop();
      await w.ph.close();
    }
  }, 180_000);

  test("the builder's fixing edit starts it again; a still-broken edit is told again; the third stop in an hour is the last notice until the user restarts it; the user's stop stays", async () => {
    const w = await world("clover-b-crash-fix-");
    try {
      await w.install("reel", { "clover.json": manifest("reel", "Reel"), "package.json": "{\"type\":\"module\"}", "host/index.js": THROWS("bug one") }, "bot");
      await w.crashToStop("reel");
      await until("the first notice", 20_000, () => (w.delivered.length === 1 ? true : undefined));
      const cards = w.broker.cards().length;

      // The fix: applied with no card, and the plugin runs it with a fresh crash count.
      await w.edit("reel", "host/index.js", WORKS("fixed"));
      await until("reel running the fix", 30_000, () => (w.ph.host.status("reel").state === "running" ? true : undefined));
      expect(w.ph.host.status("reel")).toMatchObject({ state: "running", crashes: 0 });
      expect(await w.ph.host.invoke({ pluginId: "reel", handler: "ping", args: null, caller: USER })).toBe("fixed");
      expect(w.broker.cards().length).toBe(cards);
      expect(w.lines.some((l) => l.includes("reel: its tree changed after the crash rules stopped it; it starts again"))).toBe(true);

      // A still-broken edit: the running plugin reloads onto it, crashes to a stop, and its builder is told again.
      await w.edit("reel", "host/index.js", THROWS("bug two"));
      await w.crashToStop("reel");
      await until("the second notice", 20_000, () => (w.delivered.length === 2 ? true : undefined));
      expect(w.delivered[1]!.text).toBe(crashNoticeText("Reel", "reel", reason("bug two")));
      // Another broken edit: the stop that makes three in the hour says it is the last notice for now.
      await w.edit("reel", "host/index.js", THROWS("bug three"));
      await until("restarted by the edit", 20_000, () => (w.ph.host.status("reel").state !== "stopped" ? true : undefined));
      await w.crashToStop("reel");
      await until("the third notice", 20_000, () => (w.delivered.length === 3 ? true : undefined));
      expect(w.delivered[2]!.text).toBe(crashNoticeText("Reel", "reel", reason("bug three"), true));
      expect(w.delivered[2]!.text).toEndWith("That makes 3 stops within an hour: you won't be told of another until the user restarts it or an hour passes.");
      // A fourth: started again by the edit, stopped again, and no notice.
      await w.edit("reel", "host/index.js", THROWS("bug four"));
      await until("restarted by the edit", 20_000, () => (w.ph.host.status("reel").state !== "stopped" ? true : undefined));
      await w.crashToStop("reel");
      await flush();
      expect(w.delivered.length).toBe(3);
      expect(w.lines.some((l) => l.includes("reel stopped; its builder alpha isn't told again (3 stops within the hour)"))).toBe(true);
      // The user's restart lifts the cap.
      w.notices.userRestarted("reel");
      void w.ph.host.restart("reel").catch(() => {});
      await until("reel restarted", 20_000, () => (w.ph.host.status("reel").state !== "stopped" ? true : undefined));
      await w.crashToStop("reel");
      await until("the notice after the user's restart", 20_000, () => (w.delivered.length === 4 ? true : undefined));

      // A plugin the user stopped stays stopped through an edit.
      await w.edit("reel", "host/index.js", WORKS("fixed again"));
      await until("reel running the fix", 30_000, () => (w.ph.host.status("reel").state === "running" ? true : undefined));
      await w.ph.host.stop("reel", "the user stopped it");
      await w.edit("reel", "host/index.js", WORKS("fixed, edited"));
      await Bun.sleep(300);
      expect(w.ph.host.status("reel")).toMatchObject({ state: "stopped", reason: "the user stopped it" });
    } finally {
      w.notices.stop();
      await w.ph.close();
    }
  }, 240_000);

  test("a child of a bot's plugin (a tree shaped like reel: a top and two children) is named by its own id, whose log PluginStatus shows its builder", async () => {
    const w = await world("clover-b-crash-child-");
    try {
      await w.install("reel", {
        "clover.json": manifest("reel", "Reel"), "package.json": "{\"type\":\"module\"}", "host/index.js": WORKS("reel"),
        "plugins/fx/clover.json": JSON.stringify({ manifest: 1, name: "Reel effects", engines: { clover: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js" } }),
        "plugins/fx/package.json": "{\"type\":\"module\"}",
        "plugins/fx/host/index.js": THROWS("the effects folder is missing"),
        "plugins/export/clover.json": JSON.stringify({ manifest: 1, name: "Reel export", engines: { clover: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js" } }),
        "plugins/export/package.json": "{\"type\":\"module\"}",
        "plugins/export/host/index.js": WORKS("export"),
      }, "bot");
      // Every entry of the tree has the tree's provenance: built by Alpha.
      for (const id of ["reel", "reel/fx", "reel/export"]) expect([id, w.opened.registry.get(id)?.provenance]).toMatchObject([id, { by: "bot", bot: "alpha" }]);
      expect(await w.ph.host.invoke({ pluginId: "reel/export", handler: "ping", args: null, caller: USER })).toBe("export");

      await w.crashToStop("reel/fx");
      await until("the child's notice", 20_000, () => (w.delivered.length === 1 ? true : undefined));
      expect(w.delivered[0]!.text).toBe(crashNoticeText("Reel effects", "reel/fx", reason("the effects folder is missing")));
      // The id it names is one PluginStatus takes from its builder, and the log it shows is the child's own.
      const workshop = new PluginWorkshop({ home: w.home, registry: w.opened.registry, folders: w.opened.folders });
      const status = await workshop.status({ bot: "alpha", sessionId: "b_alpha" }, "reel/fx");
      expect(status.id).toBe("reel/fx");
      expect(status.logs.some((l: string) => l.includes("starting"))).toBe(true);
      // The top and the other child run on.
      expect(w.ph.host.status("reel/export").state).toBe("running");
    } finally {
      w.notices.stop();
      await w.ph.close();
    }
  }, 180_000);
});
