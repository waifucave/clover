// Clover Voice's queue rule (§6.6), on a fake player and clock: one sound at a time; the same bot's newer reply replaces
// its playing one; anything else waits its turn, first come first served; push-to-talk stops what sounds and holds
// the queue until it ends; the user's stop ends a bot's sound and drops what it has waiting; at most eight plugins'
// sounds wait.
import { describe, expect, test } from "bun:test";
import { LATENCY_SLACK_MS, VoiceQueue, WAITING_SOUNDS, type Played, type QueueItem } from "../src/queue";

function world() {
  let now = 1_000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 0;
  const log: string[] = [];
  const pending = new Map<string, (p: Played) => void>();
  const sounding: string[] = [];
  let most = 0;
  const begin = (item: QueueItem) => {
    sounding.push(item.ticket);
    most = Math.max(most, sounding.length);
    log.push(`start ${item.ticket}`);
    return new Promise<Played>((resolve) => pending.set(item.ticket, (p) => {
      sounding.splice(sounding.indexOf(item.ticket), 1);
      resolve(p);
    }));
  };
  const q = new VoiceQueue(
    {
      say: (item) => begin(item),
      play: (item) => begin(item),
      stop: (item) => {
        log.push(`stop ${item.ticket}`);
        pending.get(item.ticket)?.({ seconds: 0, cut: true });
      },
    },
    { now: () => now, setTimeout: (fn, ms) => { timers.set(++next, { at: now + ms, fn }); return next; }, clearTimeout: (h) => void timers.delete(h as number) },
  );
  const flush = () => new Promise((r) => setTimeout(r, 0));
  /** The player finished sending `ticket` (one second of sound, first piece now). */
  const sent = async (ticket: string, seconds = 1) => {
    pending.get(ticket)?.({ seconds, firstAt: now, cut: false });
    await flush();
  };
  /** Time passes; due timers run. */
  const pass = async (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
    await flush();
  };
  const reply = (ticket: string, bot: string, asked = false) => q.reply({ kind: "reply", ticket, bot, session: `b_${bot}`, asked, voice: { provider: "p", voice: "v" } });
  const sound = (ticket: string, bot: string) => q.offer({ kind: "sound", ticket, bot, from: "plug" });
  return { q, log, sent, pass, reply, sound, most: () => most };
}

describe("Clover Voice's queue", () => {
  test("two bots: the second waits until the first has sounded out (its length and the device's latency), first come first served", async () => {
    const w = world();
    expect(w.reply("a1", "alpha")).toEqual({ queued: false });
    expect(w.reply("b1", "beta")).toEqual({ queued: true });
    expect(w.sound("s1", "gamma")).toEqual({ queued: true });
    await w.sent("a1", 2);
    await w.pass(2_000);
    expect(w.log).toEqual(["start a1"]);
    await w.pass(LATENCY_SLACK_MS);
    expect(w.log).toEqual(["start a1", "start b1"]);
    await w.sent("b1", 1);
    await w.pass(1_000 + LATENCY_SLACK_MS);
    expect(w.log).toEqual(["start a1", "start b1", "start s1"]);
    expect(w.most()).toBe(1);
  });

  test("same bot: its newer reply replaces the playing one at once, and the newest replaces one waiting", async () => {
    const w = world();
    w.reply("a1", "alpha");
    expect(w.reply("a2", "alpha")).toEqual({ queued: false });
    expect(w.log).toEqual(["start a1", "stop a1", "start a2"]);
    w.reply("b1", "beta");
    w.reply("b2", "beta");
    expect(w.q.state.waiting.map((x) => x.ticket)).toEqual(["b2"]);
    expect(w.most()).toBe(1);
  });

  test("a sound a plugin plays as the bot, or the reply the user asked for, waits its turn behind the bot's reply", async () => {
    const w = world();
    w.reply("a1", "alpha");
    expect(w.sound("s1", "alpha")).toEqual({ queued: true });
    expect(w.reply("a0", "alpha", true)).toEqual({ queued: true });
    expect(w.log).toEqual(["start a1"]);
    await w.sent("a1", 1);
    await w.pass(1_000 + LATENCY_SLACK_MS);
    expect(w.log).toEqual(["start a1", "start s1"]);
  });

  test("push-to-talk stops what sounds at once and nothing starts until it ends; what came meanwhile plays after", async () => {
    const w = world();
    w.reply("a1", "alpha");
    w.q.hold("ptt1");
    expect(w.log).toEqual(["start a1", "stop a1"]);
    expect(w.reply("b1", "beta")).toEqual({ queued: true });
    expect(w.reply("a2", "alpha")).toEqual({ queued: true });
    expect(w.log).toEqual(["start a1", "stop a1"]);
    w.q.release("ptt1");
    expect(w.log).toEqual(["start a1", "stop a1", "start b1"]);
  });

  test("the user's stop ends the bot's sound and drops what it has waiting; another bot's still plays", async () => {
    const w = world();
    w.reply("a1", "alpha");
    w.sound("s1", "alpha");
    w.reply("b1", "beta");
    w.q.stop("alpha");
    expect(w.log).toEqual(["start a1", "stop s1", "stop a1", "start b1"]);
  });

  test(`at most ${WAITING_SOUNDS} plugins' sounds wait; the oldest goes; a reply is never dropped for room`, async () => {
    const w = world();
    w.reply("a1", "alpha");
    for (let i = 0; i < WAITING_SOUNDS + 2; i++) w.sound(`s${i}`, "beta");
    w.reply("b1", "beta");
    const waiting = w.q.state.waiting.map((x) => x.ticket);
    expect(waiting).toEqual([...Array.from({ length: WAITING_SOUNDS }, (_, i) => `s${i + 2}`), "b1"]);
    expect(w.log.filter((l) => l.startsWith("stop"))).toEqual(["stop s0", "stop s1"]);
  });

  test("a reply that fails or is cut ends its turn at once", async () => {
    const w = world();
    w.reply("a1", "alpha");
    w.reply("b1", "beta");
    w.q.stop("alpha");
    expect(w.log.at(-1)).toBe("start b1");
  });
});
