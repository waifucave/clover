// Every call the SDK's catalog (`API_CALLS`) lists for host code is served by a handler on the router the daemon builds,
// or is named below as not served yet, with why. A host half that calls a listed member the core doesn't serve gets
// "not served on this computer" at run time (that is how the bundled desktop notifier lost every banner to `t`), so a
// call added to the catalog without a handler fails here, not in a plugin. A call that becomes served must leave the
// list (no stale entries).
//
// The handler sources are the ones the daemon composes: `startPluginHost`'s own list (daemon-host.ts), the daemon's
// `handlers` (the notify service's) and the model plugins' `addApiHandlers`. A source scan holds the composition to
// this list, so a new source added there without being added here fails too.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_CALLS, type ApiCallPath } from "@waifucave/clover-plugin-sdk";
import { commandsApi } from "../../commands/views";
import { NotifyService } from "../../notify/service";
import { modelPluginApiHandlers } from "../../runtime-sdk/model-plugins/plugin-api";
import { areasParts } from "../api/areas";
import { confirmApi } from "../api/confirm";
import { pointsApi } from "../api/points";
import { settingsApi } from "../api/settings";
import { storageApi } from "../api/storage";

const SRC = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/** Host-side calls the catalog lists that no router handler serves yet, by area, each with why. */
const NOT_SERVED_YET: Partial<Record<ApiCallPath, string>> = {
  "commands.run": "a plugin running another's command: the router checks `call:` and the target, but no handler runs it yet",
  "keys.publicKey": "the `clover` tree's device keys: no handler on the router yet",
  "keys.open": "the `clover` tree's device keys: no handler on the router yet",
  "keys.delete": "the `clover` tree's device keys: no handler on the router yet",
  "conversation.answer": "answering a question card as the plugin: no service on main yet (areas.ts)",
  "memory.list": "a bot's memory: no handler on the router yet",
  "memory.read": "a bot's memory: no handler on the router yet",
  "routines.list": "routines: no handler on the router yet",
  "routines.runs": "routines: no handler on the router yet",
  "approvals.pending": "approvals: no handler on the router yet",
  "approvals.watch": "approvals: no handler on the router yet",
  "browser.tabs": "the Clover Browser: its peer methods (browser/peers.ts) serve links, not the router",
  "browser.open": "the Clover Browser: its peer methods serve links, not the router",
  "browser.close": "the Clover Browser: its peer methods serve links, not the router",
  "browser.navigate": "the Clover Browser: its peer methods serve links, not the router",
  "browser.show": "the Clover Browser: its peer methods serve links, not the router",
  "browser.hide": "the Clover Browser: its peer methods serve links, not the router",
  "browser.screenshot": "the Clover Browser: its peer methods serve links, not the router",
  "browser.cdp": "the Clover Browser: its peer methods serve links, not the router",
  "browser.onCdpEvent": "the Clover Browser: its peer methods serve links, not the router",
  "browser.watch": "the Clover Browser: its peer methods serve links, not the router",
  "usage.rows": "usage: no handler on the router yet",
  "usage.plans": "usage: no handler on the router yet",
  "usage.summary": "usage: no handler on the router yet",
  "usage.watch": "usage: no handler on the router yet",
  "logs.read": "a plugin reading logs: no handler on the router yet",
  "logs.follow": "a plugin reading logs: no handler on the router yet",
  "audio.play": "audio: no handler on the router yet",
  "audio.onRecording": "audio: no handler on the router yet",
};

/** The router's own calls, written inline in daemon-host.ts (a component's `host.call`, a host half's `ui.send`). */
const INLINE = ["host.call", "ui.send"] as const;

function served(): Set<string> {
  const f = {} as never;
  const lists = [
    pointsApi(f), storageApi(f), settingsApi(f), commandsApi(f),
    areasParts({ bots: () => undefined, node: () => undefined, links: () => undefined }).handlers,
    confirmApi(f),
    new NotifyService({ registry: { entries: () => [] }, home: "/nonexistent" } as never).apiHandlers(),
    modelPluginApiHandlers(f),
  ];
  return new Set([...lists.flatMap((l) => Object.keys(l)), ...INLINE]);
}

describe("every call the catalog lists for host code is served", () => {
  test("each host-side call has a router handler, or is named as not served yet with why; none named is served", () => {
    const have = served();
    const host = (Object.entries(API_CALLS) as [ApiCallPath, { where: string }][]).filter(([, v]) => v.where !== "ui").map(([k]) => k);
    expect(host.filter((p) => !have.has(p) && NOT_SERVED_YET[p] === undefined)).toEqual([]);
    expect(Object.keys(NOT_SERVED_YET).filter((p) => have.has(p) || !host.includes(p as ApiCallPath))).toEqual([]);
  });

  test("`t` is a component's alone: no host half has one, and the core refuses it there", () => {
    expect(API_CALLS.t).toEqual({ where: "ui" });
    expect(served().has("t")).toBe(false);
  });

  test("the daemon composes exactly these sources", () => {
    const host = read("plugin-host/daemon-host.ts");
    const list = host.slice(host.indexOf("const handlers: ApiHandlers[] = ["), host.indexOf("const recordOf ="));
    const factories = [...list.matchAll(/\b([a-z][A-Za-z]*Api)\(/g)].map((m) => m[1]);
    expect(factories.sort()).toEqual(["commandsApi", "confirmApi", "pointsApi", "settingsApi", "storageApi"]);
    expect(list).toContain("areas.handlers");
    expect(list).toContain("...(o.handlers ?? [])");
    expect([...list.matchAll(/^\s+"([a-z.]+[A-Za-z]*)": /gm)].map((m) => m[1]).sort()).toEqual([...INLINE].sort());
    const daemon = read("daemon.ts");
    expect(daemon).toContain("handlers: [notify.apiHandlers()]");
    // `addApiHandlers` is handed only to the model plugins' start, which adds `modelPluginApiHandlers` and nothing else.
    expect([...daemon.matchAll(/addApiHandlers:/g)].length).toBe(1);
    expect([...daemon.matchAll(/\.addApiHandlers\(/g)].length).toBe(1);
    expect([...read("runtime-sdk/model-plugins/start.ts").matchAll(/addApiHandlers\?\.\(([a-zA-Z]+)\(/g)].map((m) => m[1])).toEqual(["modelPluginApiHandlers"]);
  });
});
