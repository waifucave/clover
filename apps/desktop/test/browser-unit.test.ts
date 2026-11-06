// The browser module's logic that needs no Electron: the popup choice, the screen-reader switch, and that the app's
// mirror of lane B's contract matches the core's. The Electron side runs in CI only (`browser.test.ts`).
import { describe, expect, test } from "bun:test";
import * as appContract from "../src/main/browser/contract";
import { choosePopup, siteOf } from "../src/main/browser/popups";
import { parseGdbusBool, parseMacVoiceOver, parseWindowsTasklist, ScreenReaderSwitch, type ScreenReaderProbe } from "../src/main/browser/screen-reader";
import * as coreContract from "../../../packages/core/src/browser/contract";
import { CDP_DENIED_METHODS as CORE_DENIED_METHODS, partitionFor as corePartitionFor } from "../../../packages/core/src/browser/policy";

describe("the contract mirrors", () => {
  test("the app's and the core's copies of lane B's contract agree", () => {
    expect(appContract.AGENT_VIEWPORT).toEqual(coreContract.AGENT_VIEWPORT);
    expect([...appContract.CDP_ALLOWED_DOMAINS]).toEqual([...coreContract.CDP_ALLOWED_DOMAINS]);
    expect([...appContract.CDP_DENIED_DOMAINS]).toEqual([...coreContract.CDP_DENIED_DOMAINS]);
    expect([...appContract.BROWSER_REFUSED_SCHEMES]).toEqual([...coreContract.BROWSER_REFUSED_SCHEMES]);
    for (const url of ["https://a.b/", "file:///x", "about:blank", "about:config", "clover-ui://x", "chrome://gpu", "data:text/plain,x"]) {
      expect(appContract.isBrowserUrlAllowed(url)).toBe(coreContract.isBrowserUrlAllowed(url));
    }
    for (const m of ["Page.reload", "Target.getTargets", "Runtime.evaluate", "Tracing.start", "Browser.close"]) {
      expect(appContract.isCdpMethodAllowed(m)).toBe(coreContract.isCdpMethodAllowed(m));
    }
    // The methods refused inside allowed domains: the same list, refused on the tab's debugger too.
    expect([...appContract.CDP_DENIED_METHODS]).toEqual([...CORE_DENIED_METHODS]);
    for (const m of CORE_DENIED_METHODS) expect(appContract.isCdpCallAllowed(m)).toBe(false);
    expect(appContract.isCdpCallAllowed("Page.reload")).toBe(true);
    for (const owner of [{ kind: "user" }, { kind: "bot", bot: "alpha" }, { kind: "bot", bot: "pack/luna" }, { kind: "session", session: "sess_1" }, { kind: "session", session: "a:b.c-d" }, { kind: "plugin", plugin: "acme/tool" }] as const) {
      expect(appContract.partitionFor(owner)).toBe(corePartitionFor(owner));
    }
  });
});

describe("a page's windows", () => {
  test("a site is the scheme and the last two labels; IPs and one-label hosts are their own", () => {
    expect(siteOf("https://accounts.example.com/x")).toBe("https://example.com");
    expect(siteOf("http://127.0.0.1:8080/a")).toBe("http://127.0.0.1");
    expect(siteOf("http://localhost:8080/a")).toBe("http://localhost");
    expect(siteOf("about:blank")).toBeUndefined();
  });

  test("cross-site stays offscreen; same-site is a real window while watched, else a new tab", () => {
    expect(choosePopup("https://shop.example/", "https://accounts.idp.example/", false)).toBe("offscreen-tab");
    expect(choosePopup("http://127.0.0.1:8080/", "http://localhost:8080/popup", false)).toBe("offscreen-tab");
    expect(choosePopup("https://a.example.com/", "https://b.example.com/popup", true)).toBe("real-window");
    expect(choosePopup("https://a.example.com/", "https://a.example.com/popup", false)).toBe("new-tab");
    // A blank opener (about:blank) can't be told apart: treated as same-site.
    expect(choosePopup("about:blank", "https://x.example/", false)).toBe("new-tab");
  });
});

describe("the screen-reader switch", () => {
  test("each OS's signal is read from its tool's output", () => {
    expect(parseMacVoiceOver("1\n")).toBe(true);
    expect(parseMacVoiceOver("0\n")).toBe(false);
    expect(parseMacVoiceOver("")).toBeUndefined();
    expect(parseWindowsTasklist('"explorer.exe","1","Console","1","10 K"\r\n"Narrator.exe","2","Console","1","9 K"\r\n')).toBe(true);
    expect(parseWindowsTasklist('"explorer.exe","1","Console","1","10 K"\r\n')).toBe(false);
    expect(parseWindowsTasklist('"nvda.exe","3","Console","1","9 K"')).toBe(true);
    expect(parseGdbusBool("(<true>,)\n")).toBe(true);
    expect(parseGdbusBool("(<false>,)\n")).toBe(false);
    expect(parseGdbusBool("Error: no bus")).toBeUndefined();
  });

  function electron(enabled: boolean) {
    const listeners: ((e: unknown, on: boolean) => void)[] = [];
    return {
      state: enabled,
      isAccessibilitySupportEnabled() { return this.state; },
      on(_event: "accessibility-support-changed", l: (e: unknown, on: boolean) => void) { listeners.push(l); return this; },
      fire(on: boolean) { this.state = on; for (const l of listeners) l({}, on); },
    };
  }
  const probe = (value: boolean | undefined): ScreenReaderProbe & { value: boolean | undefined } => ({ name: "test", value, async read() { return this.value; } });

  test("an OS signal that answers wins over Electron's state, which turns on for any assistive client", async () => {
    const os = probe(false);
    const s = new ScreenReaderSwitch({ electron: electron(true), probes: [os], pollMs: 60_000 });
    await s.start();
    expect(s.on).toBe(false);
    os.value = true;
    expect(await s.refresh()).toBe(true);
    s.stop();
  });

  test("with no OS signal, Electron's state decides, and its change event is heard", async () => {
    const e = electron(false);
    const changes: boolean[] = [];
    const s = new ScreenReaderSwitch({ electron: e, probes: [probe(undefined)], pollMs: 60_000, onChange: (on) => changes.push(on) });
    await s.start();
    expect(s.on).toBe(false);
    e.fire(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(s.on).toBe(true);
    expect(changes).toEqual([true]);
    s.stop();
  });

  test("an override fixes the answer", async () => {
    const s = new ScreenReaderSwitch({ electron: electron(false), probes: [probe(false)], override: true });
    await s.start();
    expect(s.on).toBe(true);
    s.stop();
  });
});
