// What a plugin's `computers.*` and `files.*` calls do (spec §5.4: `computers.read`, `computers.control`, `files`; the
// plugin SDK's `ComputersApi` and `FilesApi`). The core's API router (lane B's `ApiRouter`, behind `guardApiRouter`
// and the capability table in `catalogs/api-calls.ts`) hands each call here with the plugin's id; nothing here checks
// capabilities.
//
// * `computers.*` reads the registry and, with `computers.control`, takes and releases holds, sets the user-working
//   mark and the action signal for opensky (§9.2). A refused hold is an answer, not an error: `held: false` with the
//   reason, as `ComputersApi.takeHold` says.
// * `files.*` is the tree, called as the plugin: fenced by the computer that holds the files (§5.4). A code session's
//   Files panel (lane F's `panel-files`, the owner's item 88) lists, reads and watches under the session's folder
//   with these, plus `files.watch` (lane J's addition, requested of lane B).
import type { Caller, ComputerView, HoldTarget, HoldView } from "@waifucave/clover-protocol";
import { ContractError, isContractError, type Unsubscribe } from "../contracts/common";
import type { ComputerRegistry } from "../contracts/computer-registry";
import type { HoldRouter } from "./holds";
import type { CoreTree } from "../tree/tree";
import type { TreeWatchEvent } from "../tree/watch";

/** One call's handler: the call's arguments, as the plugin passed them, and who made it. */
export type ApiRoute = (args: unknown[], ctx: { pluginId: string; caller: Caller }) => Promise<unknown>;

const s = (v: unknown, name: string): string => {
  if (typeof v !== "string" || v === "") throw new ContractError("invalid", `${name} is a string`);
  return v;
};
const opt = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const target = (v: unknown): HoldTarget => {
  const t = opt(v);
  if (t.kind === "app" && typeof t.app === "string" && t.app !== "") return { kind: "app", app: t.app };
  if (t.kind === "window" && typeof t.app === "string" && t.app !== "" && typeof t.window === "string" && t.window !== "") return { kind: "window", app: t.app, window: t.window };
  throw new ContractError("invalid", "a hold's target is an app, or a window of one");
};

/** `holds` routes a hold to the computer whose screen it is (review minor 4); without it, holds are kept here. */
export function computersApiRoutes(registry: ComputerRegistry, holds?: HoldRouter): Record<string, ApiRoute> {
  const must = (name: string): ComputerView => {
    const c = registry.get(name);
    if (!c) throw new ContractError("not_found", `no computer ${name}`);
    return c;
  };
  return {
    "computers.list": async () => registry.list(),
    "computers.get": async ([name]) => must(s(name, "name")),
    "computers.holds": async ([name]) => {
      const c = must(s(name, "computer"));
      if (holds) return holds.holds(c.name);
      return { holds: registry.holds(c.name), userWorking: registry.userWorking(c.name).length > 0 };
    },
    "computers.takeHold": async ([computer, t], { pluginId, caller }) => {
      // The hold's session is the one the router says made the call, never one the plugin names (review minor 3).
      const session = caller.kind === "session" || caller.kind === "peer" ? caller.sessionId : undefined;
      try {
        const req = { computer: s(computer, "computer"), target: target(t), pluginId, ...(session === undefined ? {} : { session }) };
        const hold: HoldView = holds ? await holds.takeHold(req) : registry.takeHold(req);
        return { held: true, hold };
      } catch (e) {
        if (isContractError(e, "held")) return { held: false, reason: "held-by-other", by: String(e.detail?.holder ?? "") };
        if (isContractError(e, "user_working")) return { held: false, reason: "user-working" };
        if (isContractError(e, "computer_offline")) return { held: false, reason: "computer-offline" };
        throw e;
      }
    },
    "computers.releaseHold": async ([id], { pluginId }) => {
      if (holds) return holds.releaseHold(s(id, "id"), pluginId);
      const hold = registry.holds().find((h) => h.id === id);
      if (hold && hold.pluginId !== pluginId) throw new ContractError("refused", "a plugin releases only the holds it took");
      if (hold) registry.releaseHold(hold.id);
    },
    "computers.setUserWorking": async ([computer, on, t]) => {
      const c = must(s(computer, "computer"));
      // The mark lifts only on the user's message or a card answer, never from a plugin (§9.2, helper 1.22.0).
      if (on !== true) throw new ContractError("refused", "the user's message or their answer to a card lifts the mark, not a plugin");
      registry.markUserWorking(c.name, target(t).app);
    },
    "computers.setActionRunning": async ([computer, running]) => {
      registry.setActionRunning(must(s(computer, "computer")).name, running === true);
    },
    "computers.cloverWindows": async ([computer]) => registry.cloverWindows(must(s(computer, "computer")).name),
  };
}

export function filesApiRoutes(tree: CoreTree): Record<string, ApiRoute> {
  const as = (ctx: { pluginId: string }): { as: Caller } => ({ as: { kind: "plugin", pluginId: ctx.pluginId } });
  const range = (o: Record<string, unknown>) => ({
    ...(typeof o.offset === "number" ? { offset: o.offset } : {}),
    ...(typeof o.length === "number" ? { length: o.length } : {}),
  });
  return {
    "files.stat": async ([path], ctx) => tree.stat(s(path, "path"), as(ctx)),
    "files.readText": async ([path, o], ctx) => {
      const d = await tree.readPart(s(path, "path"), { ...as(ctx), ...range(opt(o)), encoding: "utf8" });
      return d.encoding === "utf8" ? d.text : Buffer.from(d.data, "base64").toString("utf8");
    },
    "files.readBytes": async ([path, o], ctx) => {
      const d = await tree.readPart(s(path, "path"), { ...as(ctx), ...range(opt(o)), encoding: "base64" });
      return new Uint8Array(Buffer.from(d.encoding === "base64" ? d.data : d.text, d.encoding === "base64" ? "base64" : "utf8"));
    },
    "files.write": async ([path, data], ctx) => {
      const p = s(path, "path");
      if (typeof data === "string") return tree.write(p, { encoding: "utf8", text: data }, as(ctx));
      if (data instanceof Uint8Array) return tree.write(p, { encoding: "base64", data: Buffer.from(data).toString("base64") }, as(ctx));
      throw new ContractError("invalid", "data is a string or bytes");
    },
    "files.list": async ([path], ctx) => tree.list(s(path, "path"), as(ctx)),
    "files.remove": async ([path, o], ctx) => tree.remove(s(path, "path"), { ...as(ctx), ...(opt(o).recursive === true ? { recursive: true } : {}) }),
    "files.move": async ([from, to], ctx) => tree.move(s(from, "from"), s(to, "to"), as(ctx)),
    "files.glob": async ([pattern, o], ctx) => {
      const p = opt(o);
      return tree.globAll(s(pattern, "pattern"), { ...as(ctx), cwd: s(p.cwd, "cwd"), ...(typeof p.limit === "number" ? { limit: p.limit } : {}) });
    },
    "files.grep": async ([pattern, o], ctx) => {
      const p = opt(o);
      return tree.grepAll(s(pattern, "pattern"), {
        ...as(ctx), cwd: s(p.cwd, "cwd"),
        ...(typeof p.glob === "string" ? { glob: p.glob } : {}), ...(typeof p.limit === "number" ? { limit: p.limit } : {}),
      });
    },
  };
}

/** `files.watch` (requested of lane B): change events under a folder, for a code session's Files panel. The router
 *  delivers each event to the plugin as its own live event; the plugin's unsubscribe ends it. */
export function filesWatch(tree: CoreTree, ctx: { pluginId: string }, path: string, fn: (e: TreeWatchEvent) => void): Promise<Unsubscribe> {
  return tree.watch(s(path, "path"), { as: { kind: "plugin", pluginId: ctx.pluginId } }, fn);
}
