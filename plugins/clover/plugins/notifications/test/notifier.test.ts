import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_PREFS, DesktopNotifier, noticeId, noticeWords, wanted, type DesktopNotice, type DesktopNotifications, type NotifierUpdate } from "../src/notifier";
import { english } from "../src/strings";
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
const CLOVER = { pluginId: "clover", name: "Clover", thirdParty: false };
const plugin = (pluginId: string, name: string, bundled = false) => ({ pluginId, name, thirdParty: !bundled });
const update = (kind: NotifierUpdate["kind"], more: Partial<NotifierUpdate> = {}): NotifierUpdate => ({ seq: ++seq, kind, unseen: seq, at: 1_000 + seq, sender: CLOVER, ...more });
const NAMES: Record<string, string> = { alpha: "Alpha", luna: "Luna" };

describe("the banner's words: who and what happened, never what was said", () => {
  test("each kind; how many wait is the core's own count (unseen), never the notifier's", () => {
    expect(noticeWords(update("message", { bot: "alpha", unseen: 1 }), "Alpha")).toEqual({ title: "Alpha", body: "Sent you a message" });
    expect(noticeWords(update("message", { bot: "alpha", unseen: 3 }), "Alpha")).toEqual({ title: "Alpha", body: "Sent you a message · 3 unseen" });
    expect(noticeWords(update("card", { unseen: 1 }), "Alpha").body).toBe("Needs your OK");
    expect(noticeWords(update("question", { unseen: 1 }), "Luna").body).toBe("Has a question for you");
    expect(noticeWords(update("routine-result", { unseen: 1 }), "Luna").body).toBe("A routine finished");
    expect(noticeWords(update("agent-finished", { unseen: 2 }), "Luna").body).toBe("An agent finished · 2 unseen");
    expect(noticeWords(update("message", { unseen: 1 }), undefined).title).toBe("A bot");
  });

  test("a plugin's notification comes under its name, marked as a plugin's, so no plugin speaks as a bot; the core's own under Clover's", () => {
    const spoof = update("notification", { unseen: 1, notification: { title: "Alpha needs your OK" }, sender: plugin("home", "Home") });
    expect(noticeWords(spoof, undefined)).toEqual({ title: "Plugin “Home”: Alpha needs your OK", body: undefined });
    // A plugin named as a bot still reads as a plugin.
    const asBot = update("notification", { unseen: 1, notification: { title: "Hi, it's me" }, sender: plugin("evil", "Luna") });
    expect(noticeWords(asBot, undefined).title).toBe("Plugin “Luna”: Hi, it's me");
    // A bidi control can't turn the title around its colon.
    expect(noticeWords(update("notification", { unseen: 1, notification: { title: "x" }, sender: plugin("evil", "\u202EHome") }), undefined).title).toBe("Plugin “Home”: x");
    // A bundled child is Clover's own: its name, no mark.
    expect(noticeWords(update("notification", { unseen: 1, notification: { title: "Usage at 90%" }, sender: plugin("usage", "Usage", true) }), undefined).title).toBe("Usage: Usage at 90%");
    expect(noticeWords(update("notification", { unseen: 1, notification: { title: "Usage at 90%" }, sender: CLOVER }), undefined).title).toBe("Usage at 90%");
    expect(noticeWords(update("notification", { unseen: 1, sender: plugin("home", "") }), undefined)).toEqual({ title: "Plugin “home”", body: undefined });
    // An older core that sends no sender: a plugin, unnamed.
    const bare = update("notification", { unseen: 1, notification: { title: "Alpha" } });
    delete (bare as Partial<NotifierUpdate>).sender;
    expect(noticeWords(bare, undefined).title).toBe("Plugin “A plugin”: Alpha");
  });

  test("a plugin's title and body on one line each, cut to fit", () => {
    const long = "word ".repeat(200);
    const words = noticeWords(update("notification", { unseen: 1, notification: { title: "  Build\n  finished ", body: long }, sender: plugin("ci", "CI") }), undefined);
    expect(words.title).toBe("Plugin “CI”: Build finished");
    expect(words.body!.length).toBe(400);
    expect(words.body!.endsWith("…")).toBe(true);
  });

  test("one banner per bot and kind; each plugin notification its own", () => {
    expect(noticeId(update("message", { bot: "alpha" }))).toBe("message:alpha");
    expect(noticeId(update("card"))).toBe("card:-");
    const a = update("notification");
    expect(noticeId(a)).toBe(`notification:${a.seq}`);
  });
});

describe("DesktopNotifier", () => {
  test("a busy bot replaces its banner, by name, with the core's count; cards and questions wait for the user", async () => {
    const { desktop, shown } = fakeDesktop();
    const n = new DesktopNotifier({ desktop, botName: (id) => NAMES[id] });
    await n.notify(update("message", { bot: "alpha", session: "s1", unseen: 1 }));
    // The core coalesced two updates into this one: its count says 3, whatever the notifier saw.
    await n.notify({ ...update("message", { bot: "alpha", session: "s1" }), seq: seq + 5, unseen: 3 });
    seq += 5;
    await n.notify(update("card", { bot: "luna", unseen: 4 }));
    await n.notify(update("message", { bot: "ghost", unseen: 5 }));
    expect(shown.map((s) => [s.id, s.title, s.body, s.urgent])).toEqual([
      ["message:alpha", "Alpha", "Sent you a message", false],
      ["message:alpha", "Alpha", "Sent you a message · 3 unseen", false],
      ["card:luna", "Luna", "Needs your OK · 4 unseen", true],
      ["message:ghost", "ghost", "Sent you a message · 5 unseen", false],
    ]);
    expect(shown[0]!.open).toEqual({ bot: "alpha", session: "s1" });
  });

  test("nothing shows while the app shows it already; the next banner carries the core's count", async () => {
    let front = true;
    const shown: DesktopNotice[] = [];
    const n = new DesktopNotifier({ desktop: { show: (x) => void shown.push(x), close: () => {}, showing: () => front } });
    await n.notify(update("question", { bot: "alpha", unseen: 1 }));
    expect(shown).toEqual([]);
    front = false;
    await n.notify(update("question", { bot: "alpha", unseen: 2 }));
    expect(shown.map((s) => s.body)).toEqual(["Has a question for you · 2 unseen"]);
  });

  test("the user caught up: every banner goes", async () => {
    const { desktop, shown, closed } = fakeDesktop();
    const n = new DesktopNotifier({ desktop, botName: (id) => NAMES[id] });
    await n.notify(update("message", { bot: "alpha", unseen: 1 }));
    await n.notify(update("card", { bot: "alpha", unseen: 2 }));
    await n.clear();
    expect(closed.sort()).toEqual(["card:alpha", "message:alpha"]);
    await n.notify(update("message", { bot: "alpha", unseen: 1 }));
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
    await n.notify(update("notification", { notification: { title: "Secret plan", body: "the body" }, sender: plugin("x", "X") }));
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
    await host.stop();
  });

  test("the words come in the user's language through the plugin API's t; a key it lacks stays English", async () => {
    const log = { info: () => {}, warn: () => {}, error: () => {} };
    const { desktop, shown } = fakeDesktop();
    const fr: Record<string, string> = { "clover.notifications.message": "Vous a envoyé un message", "clover.notifications.unseen": "{count} non lus" };
    await host.start({ log, desktop, t: (key, params) => (fr[key] ?? key).replace(/\{(\w+)\}/g, (_, n: string) => String(params?.[n] ?? "")) });
    await host.notifier.notify(update("message", { bot: "alpha", unseen: 3 }));
    await host.notifier.notify(update("card", { bot: "alpha", unseen: 1 }));
    await host.stop();
    expect(shown.map((s) => s.body)).toEqual(["Vous a envoyé un message · 3 non lus", "Needs your OK"]);
    // Stopped, English again.
    expect(noticeWords(update("message", { unseen: 1 }), "Alpha").body).toBe("Sent you a message");
  });
});

describe("the plugin's own settings (Settings → Notifications shows what a notifier declares, F-M3)", () => {
  test("the manifest declares needsYou, agentDone, routineFailed and sounds: switches, on by default, in the English table's words", () => {
    const settings = (manifest as { settings?: Record<string, { type: string; title: { en: string }; description: { en: string }; default: unknown }> }).settings!;
    expect(Object.keys(settings)).toEqual(["needsYou", "agentDone", "routineFailed", "sounds"]);
    for (const [key, s] of Object.entries(settings)) {
      expect(s.type).toBe("boolean");
      expect(s.default).toBe(true);
      expect(s.default).toBe(DEFAULT_PREFS[key as keyof typeof DEFAULT_PREFS]);
      // The manifest's text is the locale table's English, so a pack translates the keys and the two never drift.
      expect(s.title.en).toBe(english(`clover.notifications.setting.${key}`));
      expect(s.description.en).toBe(english(`clover.notifications.setting.${key}.detail`));
    }
  });

  test("each kind follows its switch; a message and a plugin's notice always show", () => {
    const off = { needsYou: false, agentDone: false, routineFailed: false, sounds: false };
    for (const kind of ["card", "question", "agent-finished", "routine-result"] as const) {
      expect([kind, wanted(update(kind), DEFAULT_PREFS)]).toEqual([kind, true]);
      expect([kind, wanted(update(kind), off)]).toEqual([kind, false]);
    }
    expect(wanted(update("message"), off)).toBe(true);
    expect(wanted(update("notification"), off)).toBe(true);
    // A routine that ran fine is not a failure, when the core says so.
    expect(wanted(update("routine-result", { failed: false }), DEFAULT_PREFS)).toBe(false);
    expect(wanted(update("routine-result", { failed: true }), DEFAULT_PREFS)).toBe(true);
  });

  test("the host half reads the settings at start and follows changes; sounds off makes every banner silent", async () => {
    const log = { info: () => {}, warn: () => {}, error: () => {} };
    const { desktop, shown } = fakeDesktop();
    const values: Record<string, unknown> = { needsYou: false, sounds: false };
    let listener: ((key: string) => void) | null = null;
    const settings = {
      get: async <T,>(key: string) => values[key] as T | undefined,
      watch: (_key: string | null, l: (key: string) => void) => ((listener = l), () => (listener = null)),
    };
    await host.start({ log, desktop, settings });
    await host.notifier.notify(update("card", { bot: "alpha", unseen: 1 }));
    await host.notifier.notify(update("agent-finished", { bot: "alpha", unseen: 1 }));
    expect(shown.map((s) => [s.body, s.silent])).toEqual([["An agent finished", true]]);
    // The user turns Needs you back on, and sounds.
    values.needsYou = true;
    values.sounds = true;
    listener!("needsYou");
    listener!("sounds");
    await new Promise((r) => setTimeout(r, 0));
    await host.notifier.notify(update("question", { bot: "alpha", unseen: 1 }));
    expect(shown.at(-1)).toMatchObject({ body: "Has a question for you", silent: false, urgent: true });
    await host.stop();
    expect(listener).toBeNull();
  });
});
