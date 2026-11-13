// Every call the SDK's catalog (`API_CALLS`) lists for host code is served by a handler on the router the daemon builds,
// or the catalog marks it not served yet (`ApiCallInfo.notYet`, with why; the SDK types it absent). A host half that calls a listed member the core doesn't serve gets
// "not served on this computer" at run time (that is how the bundled desktop notifier lost every banner to `t`), so a
// call added to the catalog without a handler fails here, not in a plugin. A call that becomes served must leave the
// list (no stale entries).
//
// The handler sources are the ones the daemon composes: `startPluginHost`'s own list (daemon-host.ts), the daemon's
// `handlers` (the notify service's) and the model plugins' `addApiHandlers`. A source scan holds the composition to
// this list, so a new source added there without being added here fails too.
import { AvatarService } from "../api/avatar";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_CALLS, type ApiCallInfo, type ApiCallPath } from "@waifucave/clover-plugin-sdk";
import { createApiRouter } from "../api/router";
import { apiHas, apiMember, HARMLESS_KEYS } from "../runtime";
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

/** Host-side calls that no router handler serves yet and that the catalog doesn't mark `notYet`. Empty, and held
 *  empty below: a call is served or marked, so the next unserved one fails here by name. */
const NOT_SERVED_YET: Partial<Record<ApiCallPath, string>> = {};

/** The router's own calls, written inline in daemon-host.ts (a component's `host.call`, a host half's `ui.send`). */
const INLINE = ["host.call", "ui.send"] as const;

function served(): Set<string> {
  const f = {} as never;
  const lists = [
    pointsApi(f), storageApi(f), settingsApi(f), commandsApi(f),
    areasParts({ bots: () => undefined, node: () => undefined, links: () => undefined, browser: () => undefined }).handlers,
    confirmApi(f),
    new AvatarService(() => undefined).handlers(),
    new NotifyService({ registry: { entries: () => [] }, home: "/nonexistent" } as never).apiHandlers(),
    modelPluginApiHandlers(f),
  ];
  return new Set([...lists.flatMap((l) => Object.keys(l)), ...INLINE]);
}

describe("every call the catalog lists for host code is served", () => {
  test("each host-side call has a router handler, or the catalog marks it not served yet (`notYet`, with why); nothing marked is served", () => {
    const have = served();
    const entries = Object.entries(API_CALLS) as [ApiCallPath, ApiCallInfo][];
    const host = entries.filter(([, v]) => v.where !== "ui" && v.notYet === undefined).map(([k]) => k);
    expect(NOT_SERVED_YET).toEqual({});
    expect(host.filter((p) => !have.has(p) && NOT_SERVED_YET[p] === undefined)).toEqual([]);
    expect(Object.keys(NOT_SERVED_YET).filter((p) => have.has(p) || !host.includes(p as ApiCallPath))).toEqual([]);
    // A marked call is served by no handler (or the mark is stale), and its reason says why.
    for (const [p, v] of entries.filter(([, v]) => v.notYet !== undefined)) {
      expect([p, have.has(p)]).toEqual([p, false]);
      expect([p, (v.notYet ?? "").length > 10]).toEqual([p, true]);
    }
  });

  test("the router refuses a marked call with its reason, whatever the plugin holds", async () => {
    const record = { id: "luna", enabled: true, state: "running", granted: ["memory.read", "usage.read", "logs.read", "audio", "approvals", "browser", "call:sol"] } as never;
    const router = createApiRouter({ registry: { get: () => record }, handlers: [] });
    for (const path of ["memory.list", "keys.open", "commands.run", "audio.play"]) {
      const err = await router({ pluginId: "luna", process: path === "keys.open" ? "clover" : "shared", path, args: ["x"], caller: { kind: "plugin", pluginId: "luna" } } as never).catch((e: Error) => e);
      expect([path, (err as Error).message]).toEqual([path, `${path} isn't available yet: ${(API_CALLS as Record<string, ApiCallInfo>)[path]!.notYet}`]);
    }
  });

  test("a host half has no approval cards: they exist only in components, and a layer's are the plugin's own bot's", async () => {
    const record = { id: "luna", enabled: true, state: "running", granted: ["approvals"] } as never;
    const router = createApiRouter({ registry: { get: () => record }, handlers: [] });
    for (const path of ["approvals.pending", "approvals.watch"]) {
      const err = await router({ pluginId: "luna", process: "shared", path, args: [], caller: { kind: "plugin", pluginId: "luna" } } as never).catch((e: Error) => e);
      expect([path, (err as Error).message]).toEqual([path, `${path} exists only in components`]);
    }
  });

  test("the host proxy: every catalog path is a member at each depth, no harmless key is a catalog name, and `in` is false for a call not served yet", () => {
    for (const call of Object.keys(API_CALLS)) {
      const parts = call.split(".");
      parts.forEach((part, i) => expect([call, i, apiMember(parts.slice(0, i), part)]).toEqual([call, i, "member"]));
      for (const part of parts) expect([call, HARMLESS_KEYS.has(part)]).toEqual([call, false]);
    }
    expect(apiMember([], "env")).toBe("unknown");
    expect(apiMember(["settings", "get"], "bind")).toBe("function");
    expect(apiMember(["settings", "get"], "_isMockFunction")).toBe("harmless");
    // `in`: true for what a host half can call, false for a not-yet call (and its area when nothing in it is served),
    // a component's alone, or no member at all.
    for (const [call, info] of Object.entries(API_CALLS) as [string, ApiCallInfo][]) {
      const parts = call.split(".");
      expect([call, apiHas(parts.slice(0, -1), parts.at(-1)!)]).toEqual([call, info.notYet === undefined && info.where !== "ui"]);
    }
    expect([apiHas([], "memory"), apiHas([], "browser"), apiHas(["browser"], "tabs"), apiHas(["browser"], "show"), apiHas(["browser"], "watch"), apiHas(["commands"], "run"), apiHas([], "t")]).toEqual([false, true, true, true, false, false, false]);
    expect([apiHas([], "settings"), apiHas([], "plugin"), apiHas([], "commands"), apiHas(["settings"], "get"), apiHas([], "env"), apiHas([], Symbol.iterator)]).toEqual([true, true, true, true, false, false]);
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
