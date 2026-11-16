// The microphone for the `ui` session's frames (ui/microphone.ts): a frame whose layer holds `microphone` may open it, for
// audio alone, in a window; nothing else ever. The `moss` layer is judged the same way (MOSS Voice holds it for its
// hold-to-talk button). Driven with fake details; no test opens a device or asks the system.
import { describe, expect, test } from "bun:test";
import { commonHeaders, layerHeaders, layerMicrophone, withMicrophone } from "../src/main/ui/documents";
import { micHandlers, micPermission } from "../src/main/ui/microphone";

const holders = (layers: string[]) => (layer: string) => layers.includes(layer);
const ask = { permission: "media", mediaTypes: ["audio"], requestingUrl: "moss-plugin://acc-mic/doc/index.html?mount=a", windowId: 5 };

describe("a layer that holds `microphone`", () => {
  test("its own frames may open it (audio alone, in any window), no other layer's frame may", () => {
    expect(micPermission(ask, "moss-plugin", holders(["acc-mic"]))).toBe(true);
    expect(micPermission(ask, "moss-plugin", holders(["acc-other"]))).toBe(false);
    expect(micPermission(ask, "moss-plugin", holders([]))).toBe(false);
    expect(micPermission({ ...ask, requestingUrl: "moss-plugin://acc-mic--child/x" }, "moss-plugin", holders(["acc-mic"]))).toBe(false);
    expect(micPermission({ ...ask, requestingUrl: "moss-plugin://acc-mic.evil/x" }, "moss-plugin", holders(["acc-mic"]))).toBe(false);
    expect(micPermission({ ...ask, requestingUrl: "moss-sealed://acc-mic/x" }, "moss-plugin", holders(["acc-mic"]))).toBe(false);
  });
  test("never a camera, a screen or anything else, even for the holder", () => {
    for (const q of [{ mediaTypes: ["video"] }, { mediaTypes: ["audio", "video"] }, { mediaTypes: [] }, { mediaTypes: undefined }, { permission: "display-capture" }, { permission: "geolocation" }, { windowId: undefined }, { requestingUrl: "" }, { requestingUrl: "https://acc-mic/doc" }]) {
      expect([q, micPermission({ ...ask, ...q }, "moss-plugin", holders(["acc-mic"]))]).toEqual([q, false]);
    }
  });
  test("the moss layer by the same rule: yes while a moss plugin holds it (MOSS Voice), no once none does", () => {
    const shell = { ...ask, requestingUrl: "moss-plugin://moss/doc/index.html" };
    expect(micPermission(shell, "moss-plugin", holders(["moss"]))).toBe(true);
    expect(micPermission(shell, "moss-plugin", holders([]))).toBe(false);
    expect(micPermission({ ...shell, requestingUrl: "moss-plugin://moss.evil/doc" }, "moss-plugin", holders(["moss"]))).toBe(false);
  });
});

describe("the documents' microphone policy", () => {
  const policy = (h: Record<string, string>) => h["Permissions-Policy"]!;
  test("closed by default; a holder's own document opens it to itself; the app's own documents hand it down", () => {
    expect(policy(commonHeaders())).toContain("microphone=()");
    expect(policy(layerHeaders("text/html; charset=utf-8"))).toContain("microphone=()");
    expect(policy(layerHeaders("text/javascript"))).toContain("microphone=()");
    expect(policy(layerHeaders("text/html; charset=utf-8", [], [], false, true))).toContain("microphone=(self)");
    expect(policy(layerHeaders("text/html; charset=utf-8", [], [], false, "*"))).toContain("microphone=*");
    for (const p of [policy(layerHeaders("text/html", [], [], false, true)), policy(withMicrophone(commonHeaders(), "(self)"))]) {
      for (const closed of ["camera=()", "display-capture=()", "geolocation=()"]) expect(p).toContain(closed);
    }
  });
});

describe("the session's two handlers (request and check), driven with fake details", () => {
  const build = (o: { holders: string[]; testBuild: boolean; problem?: string }) => {
    const asked: number[] = [];
    const h = micHandlers({
      layerScheme: "moss-plugin", holds: (layer) => o.holders.includes(layer), testBuild: o.testBuild,
      windowOf: (wc) => ({ win: 3, hidden: 9, none: undefined } as Record<string, number | undefined>)[String(wc)],
      systemProblem: async () => { asked.push(1); return o.problem; },
    });
    const request = (wc: string, url: string, types: readonly string[] | undefined = ["audio"], permission = "media"): Promise<boolean> => new Promise((done) => h.request(wc, permission, done, { mediaTypes: types, requestingUrl: url }));
    const check = (wc: string, url: string, mediaType: string | undefined = "audio", permission = "media") => h.check(wc, permission, url, { mediaType, requestingUrl: url });
    return { request, check, asked, h };
  };
  const doc = (layer: string) => `moss-plugin://${layer}/?mount=abc`;

  test("a holder's frame in a window and in a hidden background window: both say yes, and they agree", async () => {
    const t = build({ holders: ["acc-mic", "moss"], testBuild: true });
    for (const wc of ["win", "hidden"]) for (const layer of ["acc-mic", "moss"]) {
      expect(t.check(wc, doc(layer))).toBe(true);
      expect(await t.request(wc, doc(layer))).toBe(true);
    }
    expect(t.asked).toEqual([]);
  });

  test("another layer's frame, video, a screen, a missing window and a bare address: both say no", async () => {
    const t = build({ holders: ["acc-mic"], testBuild: true });
    const cases: [string, string, readonly string[] | undefined, string][] = [
      ["win", doc("acc-mic-quiet"), ["audio"], "media"],
      ["win", doc("moss"), ["audio"], "media"],
      ["win", doc("acc-mic"), ["audio", "video"], "media"],
      ["win", doc("acc-mic"), ["video"], "media"],
      ["win", doc("acc-mic"), ["audio"], "display-capture"],
      ["none", doc("acc-mic"), ["audio"], "media"],
      ["win", "https://acc-mic/", ["audio"], "media"],
      ["win", "moss-plugin://acc-mic.evil/?x", ["audio"], "media"],
    ];
    for (const [wc, url, types, permission] of cases) {
      expect(await t.request(wc, url, types, permission)).toBe(false);
      expect(t.check(wc, url, types?.length === 1 ? types[0] : "unknown", permission)).toBe(false);
    }
  });

  test("a real build asks the system first, the moss layer included (a refusal there refuses it); a test build never does", async () => {
    const real = build({ holders: ["acc-mic", "moss"], testBuild: false, problem: "Microphone access is off." });
    expect(await real.request("win", doc("acc-mic"))).toBe(false);
    expect(await real.request("win", doc("moss"))).toBe(false);
    expect(real.asked.length).toBe(2);
    const granted = build({ holders: ["acc-mic"], testBuild: false });
    expect(await granted.request("hidden", doc("acc-mic"))).toBe(true);
    expect(await granted.request("win", doc("someone"))).toBe(false);
    expect(granted.asked.length).toBe(1);
  });

  test("the capability going is read live: the same handlers refuse once no plugin of the layer holds it", async () => {
    const live = ["acc-mic"];
    const h = micHandlers({ layerScheme: "moss-plugin", holds: (l) => live.includes(l), testBuild: true, windowOf: () => 3, systemProblem: async () => undefined });
    const req = () => new Promise<boolean>((done) => h.request("w", "media", done, { mediaTypes: ["audio"], requestingUrl: doc("acc-mic") }));
    expect(await req()).toBe(true);
    live.length = 0;
    expect(await req()).toBe(false);
    expect(h.check("w", "media", doc("acc-mic"), { mediaType: "audio" })).toBe(false);
  });
});

describe("one rule for every layer's document (layerMicrophone): no layer is named", () => {
  const holds = (layers: string[]) => (l: string) => layers.includes(l);
  const all = ["acc-mic", "acc-other", "alpha", "moss"];
  test("its own layer holds it: open (the bundled tree's layer and a third party's shared one alike); else closed", () => {
    expect(layerMicrophone("moss", holds(["moss"]))).toBe("*");
    // A third party's tree: the plugin and its children share the layer `acc-tree`; a child holding it opens it for the layer.
    expect(layerMicrophone("acc-tree", holds(["acc-tree"]))).toBe("*");
    // Another layer holding it opens nothing here.
    expect(layerMicrophone("alpha", holds(["acc-mic", "moss"]))).toBe(false);
    expect(layerMicrophone("moss", holds([]))).toBe(false);
    expect(policy(layerHeaders("text/html; charset=utf-8", [], all, false, layerMicrophone("alpha", holds([]))))).toContain("microphone=()");
  });
  const policy = (h: Record<string, string>) => h["Permissions-Policy"]!;
  test("the app's main process names no layer for the microphone", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    for (const f of ["src/main/ui/electron.ts", "src/main/ui/documents.ts", "src/main/ui/microphone.ts", "src/core/root.ts"]) {
      const src = readFileSync(join(import.meta.dir, "..", f), "utf8");
      // Each line that decides the microphone (a policy, an allow, a permission).
      expect(src).toMatch(/microphone/);
      for (const line of src.split("\n").filter((l) => /layerMicrophone\(|\.microphone\b|"microphone"|microphone=/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l))) expect([f, line]).toEqual([f, expect.not.stringMatching(/"moss"|moss\/voice/)]);
    }
  });
});

