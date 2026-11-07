// Desktop notifications, the app's port (lane G's notifier): shown unless the app is in front showing that session,
// replaced by the same id, closed one by one or all, and a click opens the session.
import { describe, expect, test } from "bun:test";
import { Notifications, notificationOptions, shouldShow, type NotifyRequest } from "../src/main/notify";

function setup() {
  const shown: { req: NotifyRequest; closed: boolean; click: () => void }[] = [];
  const opened: (string | undefined)[] = [];
  const n = new Notifications((req, onClick) => {
    const s = { req, closed: false, click: onClick };
    shown.push(s);
    return { close: () => void (s.closed = true) };
  }, (session) => opened.push(session));
  return { n, shown, opened };
}

describe("desktop notifications", () => {
  test("not while the app is in front showing that session; otherwise shown", () => {
    expect(shouldShow({ session: "alpha:main" }, { focused: true, session: "alpha:main" })).toBe(false);
    expect(shouldShow({ session: "alpha:main" }, { focused: true, session: "luna:main" })).toBe(true);
    expect(shouldShow({ session: "alpha:main" }, { focused: false })).toBe(true);
    // In front but showing no session (Settings open), or a notice that names none: shown.
    expect(shouldShow({ session: "alpha:main" }, { focused: true, session: null })).toBe(true);
    expect(shouldShow({}, { focused: true, session: "alpha:main" })).toBe(true);
  });

  test("the same id replaces the old one; close takes one or all; a click opens its session", () => {
    const { n, shown, opened } = setup();
    expect(n.notify({ id: "a", title: "One", session: "alpha:main" }, { focused: false })).toEqual({ shown: true });
    expect(n.notify({ id: "a", title: "One again", session: "alpha:main" }, { focused: false })).toEqual({ shown: true });
    expect(shown.map((s) => [s.req.title, s.closed])).toEqual([["One", true], ["One again", false]]);
    n.notify({ id: "b", title: "Two" }, { focused: false });
    n.close("b");
    expect(shown[2]!.closed).toBe(true);
    expect(n.count).toBe(1);
    shown[1]!.click();
    expect(opened).toEqual(["alpha:main"]);
    n.notify({ id: "c", title: "Three" }, { focused: false });
    n.close();
    expect(n.count).toBe(0);
  });

  test("in front on its session: nothing shown, and the notifier hears so", () => {
    const { n, shown } = setup();
    expect(n.notify({ id: "a", title: "One", session: "alpha:main" }, { focused: true, session: "alpha:main" })).toEqual({ shown: false });
    expect(shown).toHaveLength(0);
  });

  test("where nothing can be shown (a headless run), it says so", () => {
    const n = new Notifications(() => undefined, () => {});
    expect(n.notify({ id: "a", title: "One" }, { focused: false })).toEqual({ shown: false });
  });

  test("the OS banner's options: silent rides through; urgency stays Linux-only and urgent-only", () => {
    expect(notificationOptions({ id: "a", title: "One", silent: true }, "darwin")).toEqual({ title: "One", silent: true });
    expect(notificationOptions({ id: "a", title: "One" }, "darwin")).toEqual({ title: "One" });
    expect(notificationOptions({ id: "a", title: "One", body: "Two", silent: true }, "win32")).toEqual({ title: "One", body: "Two", silent: true });
    expect(notificationOptions({ id: "a", title: "One", urgent: true }, "linux")).toEqual({ title: "One", urgency: "critical" });
    expect(notificationOptions({ id: "a", title: "One", urgent: true }, "darwin")).toEqual({ title: "One" });
    expect(notificationOptions({ id: "a", title: "One", urgent: true, silent: true }, "linux")).toEqual({ title: "One", urgency: "critical", silent: true });
  });
});
