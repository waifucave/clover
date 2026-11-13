// The core's own updates reach the notifier plugins (spec §10; row 25 of lane B's plugins checklist: before this, only a
// plugin's own `notify.send` did). Over the real plugin registry and real plugin host (a temp plugin with a `notifiers`
// entry whose host half keeps what it was handed), a real session host's bot conversation with a fake driver, the real
// notify service and `CoreNotices`: a bot's turn the user didn't start ends and the notifier hears `message` with the bot
// and the session and none of the words; the user's own turn tells it nothing, and their next message clears; an agent's
// report, a routine's result and a waiting card or question each come as their own kind. Temp home, the fake approval
// broker, an in-memory secret store; nothing opens a window.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_API_VERSION, type NotifierUpdate } from "@waifucave/clover-plugin-sdk";
import type { Caller, SessionView } from "@waifucave/clover-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import { startPluginHost } from "../../plugin-host/daemon-host";
import { openPluginRegistry } from "../../registry/open";
import { DurableSessionHost } from "../../sessions/durable-host";
import { CoreNotices } from "../core-updates";
import { NotifyService } from "../service";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const USER: Caller = { kind: "user", client: "app" };

async function until<T>(what: string, ms: number, f: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`);
    await Bun.sleep(20);
  }
}

/** A third-party notifier: keeps each update it is handed and each `clear`, and reports them. */
const NOTIFIER_HOST = `
const got = [];
export const notifier = {
  notify: async (update) => { got.push({ ...update }); },
  clear: async () => { got.push({ cleared: true }); },
};
export const seen = async () => got;
`;

describe("the core's own updates reach the notifier plugins", () => {
  test("over a real host: a non-user turn's end, an agent's report and a routine's result come as their kinds; the user's turn tells nothing and their message clears", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "clover-e-core-notices-")));
    temps.push(home);
    const broker = new FakeApprovalBroker({ clock: new FakeClock() });
    const secrets = new MemorySecretStore();
    const opened = await openPluginRegistry({ cloverHome: home, os: "macos", broker, secrets, settleMs: 60_000 });
    const folder = join(home, "plugins", "pinger");
    mkdirSync(join(folder, "host"), { recursive: true });
    writeFileSync(join(folder, "clover.json"), JSON.stringify({
      manifest: 1, id: "pinger", name: "Pinger", version: "1.0.0", engines: { clover: `^${PLUGIN_API_VERSION}` }, host: { entry: "host/index.js" },
      contributes: { notifiers: [{ id: "ping", name: "Pinger", handler: "notifier" }] },
    }));
    writeFileSync(join(folder, "package.json"), "{\"type\":\"module\"}");
    writeFileSync(join(folder, "host", "index.js"), NOTIFIER_HOST);
    const clock = new FakeClock({ start: Date.now() });
    const ph = await startPluginHost({ home, computer: "Studio", registry: opened.registry, secrets, clock });
    const service = new NotifyService({ home, computer: "Studio", clock, registry: opened.registry, host: () => ph.host });
    const sessions = new DurableSessionHost({ home, clock });
    const driver = new FakeSessionDriver();
    sessions.open({ id: "b_alpha", kind: "bot", bot: "alpha", computer: "Studio" }, driver);
    const notices = new CoreNotices({ host: sessions, sink: service });
    try {
      await opened.folders.installed("pinger", "user-app");
      const { card } = await opened.registry.installed("pinger", "app");
      const shown = broker.cards().find((c) => c.id === card)!;
      await broker.answer(card!, { optionId: "approve", hash: shown.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(card!)!, input: "click", at: Date.now() } }, { role: "app" });
      await until("the notifier running", 15_000, () => (opened.registry.get("pinger")?.state === "running" ? true : undefined));
      const seen = async () => (await ph.host.invoke<Record<string, unknown>[]>({ pluginId: "pinger", handler: "seen", args: null, caller: USER }));
      const updates = async () => (await seen()).filter((u) => u.kind !== undefined) as unknown as NotifierUpdate[];
      const endTurn = async () => { await until("a turn running", 5_000, () => (driver.running ? true : undefined)); driver.end({ text: "done" }); await flush(); };

      // The user's own turn: nothing.
      await sessions.sendUser("b_alpha", { text: "hi", device: "d1", sentAt: clock.now(), clientMessageId: "c1" } as never);
      await endTurn();
      await Bun.sleep(150);
      expect(await updates()).toEqual([]);

      // A plugin's message starts a turn of its own; its end is the bot's message to the user: one `message`, the bot and
      // the session, never the words.
      await sessions.deliver("b_alpha", { from: "plugin", pluginId: "somebody", text: "SECRET WORDS" });
      await endTurn();
      const first = await until("the message update", 10_000, async () => (await updates()).find((u) => u.kind === "message"));
      expect(first).toMatchObject({ kind: "message", bot: "alpha", session: "b_alpha", unseen: 1, sender: { pluginId: "clover", name: "Clover", bundled: true } });
      expect(JSON.stringify(await seen())).not.toContain("SECRET WORDS");

      // An agent's report and a routine's result: their own kinds, the count going up.
      await sessions.deliver("b_alpha", { from: "task-notification", agent: "a1", backend: "claude-code", stopReason: "end_turn", text: "report", transcript: "t" } as never);
      await endTurn();
      await until("the agent's update", 10_000, async () => (await updates()).find((u) => u.kind === "agent-finished"));
      await sessions.deliver("b_alpha", { from: "routine", routine: "daily", name: "Daily", sideThread: "s1", text: "ok", failed: true });
      await until("the routine's update", 10_000, async () => (await updates()).find((u) => u.kind === "routine-result" && u.failed === true));
      // (The turn the report started is not announced as a message: its own kind said it.)
      expect((await updates()).map((u) => u.kind)).toEqual(["message", "agent-finished", "routine-result"]);
      expect((await updates()).map((u) => u.unseen)).toEqual([1, 2, 3]);

      // The user's next message: every notifier is told to clear, and the count starts again.
      await sessions.sendUser("b_alpha", { text: "back", device: "d1", sentAt: clock.now(), clientMessageId: "c2" } as never);
      await until("the clear", 10_000, async () => ((await seen()).some((u) => u.cleared === true) ? true : undefined));
      await endTurn();
      await sessions.deliver("b_alpha", { from: "plugin", pluginId: "somebody", text: "again" });
      await endTurn();
      await until("the count starting again", 10_000, async () => ((await updates()).filter((u) => u.kind === "message").at(-1)?.unseen === 1 && (await updates()).filter((u) => u.kind === "message").length === 2 ? true : undefined));
    } finally {
      notices.close();
      service.close();
      await ph.close();
      opened.close();
    }
  }, 90_000);

  test("a card or a question that now waits comes as `card` / `question`; one taken off clears; a session that isn't a bot's conversation tells nothing", () => {
    const watchers: ((v: SessionView) => void)[] = [];
    const got: string[] = [];
    const view = (id: string, kind: SessionView["kind"], needsYou?: { cards: number; questions: number }): SessionView => ({ id, kind, bot: "luna", computer: "Studio", status: "idle", startedAt: 1, updatedAt: 1, ...(needsYou ? { needsYou } : {}) } as SessionView);
    const notices = new CoreNotices({
      host: { watch: (fn) => (watchers.push(fn), () => {}), list: () => [], subscribe: () => () => {} },
      sink: { core: (u) => void got.push(`${u.kind}:${u.bot}:${u.session}`), answered: (bot) => void got.push(`answered:${bot}`) },
    });
    const emit = (v: SessionView) => watchers.forEach((w) => w(v));
    emit(view("b_luna", "bot", { cards: 0, questions: 0 })); // first sight: followed
    emit(view("b_luna", "bot", { cards: 1, questions: 0 }));
    emit(view("b_luna", "bot", { cards: 1, questions: 1 }));
    emit(view("b_luna", "bot", { cards: 0, questions: 1 }));
    emit(view("t_1", "side-thread", { cards: 0, questions: 0 }));
    emit(view("t_1", "side-thread", { cards: 2, questions: 0 }));
    expect(got).toEqual(["card:luna:b_luna", "question:luna:b_luna", "answered:luna"]);
    notices.close();
  });
});
