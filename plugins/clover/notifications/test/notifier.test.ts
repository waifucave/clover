import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DesktopNotifier, noticeId, noticeWords, type DesktopNotice, type DesktopNotifications, type NotifierUpdate } from "../src/notifier";
import * as host from "../host/index";
import { checkManifest } from "../../base-theme/src/manifest-check";
import manifest from "../clover.json" with { type: "json" };

function fakeDesktop(showing = false) {
  const shown: DesktopNotice[] = [];
  const closed: string[] = [];
  const desktop: DesktopNotifications = {
    show: (n) => void shown.push(n),
    close: (id) => void closed.push(id),
    showing: () => showing,
  };
  return { desktop, shown, closed };
}

let seq = 0;
const update = (kind: NotifierUpdate["kind"], more: Partial<NotifierUpdate> = {}): NotifierUpdate => ({ seq: ++seq, kind, unseen: seq, at: 1_000 + seq, ...more });
const NAMES: Record<string, string> = { alpha: "Alpha", luna: "Luna" };

describe("the banner's words: who and what happened, never what was said", () => {
  test("each kind, one and many", () => {
    expect(noticeWords(update("message", { bot: "alpha" }), "Alpha", 1)).toEqual({ title: "Alpha", body: "Sent you a message" });
    expect(noticeWords(update("message", { bot: "alpha" }), "Alpha", 3)).toEqual({ title: "Alpha", body: "Sent you 3 messages" });
    expect(noticeWords(update("card"), "Alpha", 1).body).toBe("Needs your OK");
    expect(noticeWords(update("card"), "Alpha", 2).body).toBe("Needs your OK on 2 things");
    expect(noticeWords(update("question"), "Luna", 1).body).toBe("Has a question for you");
    expect(noticeWords(update("routine-result"), "Luna", 1).body).toBe("A routine finished");
    expect(noticeWords(update("agent-finished"), "Luna", 2).body).toBe("2 agents finished");
    expect(noticeWords(update("message"), undefined, 1).title).toBe("A bot");
  });

  test("a plugin's notification shows its own title and body, on one line each and cut to fit", () => {
    const long = "word ".repeat(200);
    const words = noticeWords(update("notification", { notification: { title: "  Build\n  finished ", body: long } }), undefined, 1);
    expect(words.title).toBe("Build finished");
    expect(words.body!.length).toBe(400);
    expect(words.body!.endsWith("…")).toBe(true);
    expect(noticeWords(update("notification"), undefined, 1)).toEqual({ title: "Clover" });
  });

  test("one banner per bot and kind; each plugin notification its own", () => {
    expect(noticeId(update("message", { bot: "alpha" }))).toBe("message:alpha");
    expect(noticeId(update("card"))).toBe("card:-");
    const a = update("notification");
    expect(noticeId(a)).toBe(`notification:${a.seq}`);
  });
});

describe("DesktopNotifier", () => {
  test("a busy bot replaces its banner with the count, by name; cards and questions wait for the user", async () => {
    const { desktop, shown } = fakeDesktop();
    const n = new DesktopNotifier({ desktop, botName: (id) => NAMES[id] });
    await n.notify(update("message", { bot: "alpha", session: "s1" }));
    await n.notify(update("message", { bot: "alpha", session: "s1" }));
    await n.notify(update("card", { bot: "luna" }));
    await n.notify(update("message", { bot: "ghost" }));
    expect(shown.map((s) => [s.id, s.title, s.body, s.urgent])).toEqual([
      ["message:alpha", "Alpha", "Sent you a message", false],
      ["message:alpha", "Alpha", "Sent you 2 messages", false],
      ["card:luna", "Luna", "Needs your OK", true],
      ["message:ghost", "ghost", "Sent you a message", false],
    ]);
    expect(shown[0]!.open).toEqual({ bot: "alpha", session: "s1" });
  });

  test("nothing shows while the app shows it already, and the count still grows for the next banner", async () => {
    let front = true;
    const shown: DesktopNotice[] = [];
    const n = new DesktopNotifier({ desktop: { show: (x) => void shown.push(x), close: () => {}, showing: () => front } });
    await n.notify(update("question", { bot: "alpha" }));
    expect(shown).toEqual([]);
    front = false;
    await n.notify(update("question", { bot: "alpha" }));
    expect(shown.map((s) => s.body)).toEqual(["Has 2 questions for you"]);
  });

  test("the user caught up: every banner goes and the counts start again", async () => {
    const { desktop, shown, closed } = fakeDesktop();
    const n = new DesktopNotifier({ desktop, botName: (id) => NAMES[id] });
    await n.notify(update("message", { bot: "alpha" }));
    await n.notify(update("card", { bot: "alpha" }));
    await n.clear();
    expect(closed.sort()).toEqual(["card:alpha", "message:alpha"]);
    await n.notify(update("message", { bot: "alpha" }));
    expect(shown.at(-1)!.body).toBe("Sent you a message");
    await n.clear();
    await n.clear();
    expect(closed).toHaveLength(3);
  });

  test("an update older than one already shown is dropped", async () => {
    const { desktop, shown } = fakeDesktop();
    const n = new DesktopNotifier({ desktop });
    const late = update("message", { bot: "alpha" });
    await n.notify(update("message", { bot: "luna" }));
    await n.notify(late);
    expect(shown).toHaveLength(1);
  });

  test("a banner that cannot show leaves one line in the log, never its words", async () => {
    const lines: string[] = [];
    const n = new DesktopNotifier({
      desktop: { show: () => Promise.reject(new TypeError("no permission")), close: () => {} },
      log: (_level, message) => lines.push(message),
    });
    await n.notify(update("notification", { notification: { title: "Secret plan", body: "the body" } }));
    expect(lines).toEqual(["a desktop notification could not show (notification): TypeError"]);
  });
});

describe("the host half and the manifest", () => {
  afterEach(() => host.stop());

  test("runs on each computer, its handler an export of host.entry with notify and clear", () => {
    expect(manifest.contributes.notifiers).toEqual([{ id: "desktop", name: "Desktop notifications", handler: "notifier", runsOn: "each" }]);
    expect(typeof host.notifier.notify).toBe("function");
    expect(typeof host.notifier.clear).toBe("function");
    const check = checkManifest(join(import.meta.dir, ".."), { child: true });
    expect(check.problems).toEqual([]);
    expect(check.kind).toBe("code");
  });

  test("without the app's notifications it does nothing; with them, names bots through bots.read", async () => {
    const log = { info: () => {}, warn: () => {}, error: () => {} };
    await host.start({ log });
    await host.notifier.notify(update("message", { bot: "alpha" }));
    await host.stop();
    const { desktop, shown } = fakeDesktop();
    await host.start({ log, desktop, bots: { get: async (id) => (id === "alpha" ? { name: "Alpha" } : Promise.reject(new Error("no bot"))) } });
    await host.notifier.notify(update("message", { bot: "alpha" }));
    await host.notifier.notify(update("message", { bot: "gone" }));
    expect(shown.map((s) => s.title)).toEqual(["Alpha", "gone"]);
  });
});
