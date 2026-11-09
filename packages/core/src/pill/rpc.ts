// `pill.send` (packages/protocol/src/app.ts): the user's own words from the Dispatch pill, which the app's main process
// carries for a `clover` surface's `useUserSend` inside the key press or click that sent (#179's review, S2). Owner:
// lane G. The protocol lets only the `app` role call it, and only as the user (`userOnly`); the handler checks the
// caller again, since a plugin's or a bot's call must never count as the user's (§3.1, §9.1).
//
// To a bot or a session, it is the user's message exactly as the composer sends it: the same `session.stageImage` and
// `session.send` handlers (lane D's), so a bot asleep, an update closing the daemon, a bot not installed or a session
// on another computer refuse the same way. Its pictures are staged first, each named in the text as `[Image #n]`.
// To a `pill.target` entry, the words go to the entry's handler (`PillTargetHandler.send`) through the plugin host,
// as the plugin's own: the call is the plugin's, never the user's, so nothing it does with them counts as the user.
import { APP_METHODS, CLOVER_ERR, ERR } from "@waifucave/clover-protocol";
import type { PluginHost } from "../contracts/plugin-host";
import type { PluginRegistry } from "../contracts/plugin-registry";
import { ContractError } from "../contracts/common";
import { MethodError, handler, requireUser, type MethodHandler } from "../rpc/handler";

const M = APP_METHODS;

export interface PillMethodsDeps {
  /** Which session is a bot's one conversation. */
  bots: { has(id: string): boolean; mainSession(id: string): string };
  /** Lane D's handlers (`sessionsMethods`): `session.send` and `session.stageImage`. */
  sessions: Readonly<Record<string, MethodHandler>>;
  /** The `pill.target` entries (`ui` entries on that spot) and the host that runs their plugins' handlers. Absent, a
   *  send to an entry is refused as not installed. */
  targets?: { registry: Pick<PluginRegistry, "entries">; host: Pick<PluginHost, "invoke"> };
}

/** An active `pill.target` entry by its ref (`<plugin-id>#<entry-id>`), with its handler's name. */
function targetEntry(registry: Pick<PluginRegistry, "entries">, ref: string): { pluginId: string; handler: string } | undefined {
  for (const c of registry.entries("ui")) {
    const v = c.value as { spot?: unknown; handler?: unknown };
    if (c.state !== "active" || v.spot !== "pill.target" || typeof v.handler !== "string") continue;
    if (`${c.pluginId}#${c.entryId ?? ""}` === ref) return { pluginId: c.pluginId, handler: v.handler };
  }
  return undefined;
}

/** The text with an `[Image #n]` for each picture it doesn't name yet, as `session.send` asks. */
export function withImageMarks(text: string, count: number): string {
  let out = text;
  for (let n = 1; n <= count; n++) if (!out.includes(`[Image #${n}]`)) out = `${out}${out.length > 0 && !/\s$/.test(out) ? " " : ""}[Image #${n}]`;
  return out;
}

export function pillMethods(deps: PillMethodsDeps): Record<string, MethodHandler> {
  const call = (name: string): MethodHandler => {
    const h = deps.sessions[name];
    if (h === undefined) throw new MethodError(ERR.INTERNAL, `pill.send needs ${name}, which this daemon doesn't serve`);
    return h;
  };
  return {
    [M.pillSend.name]: handler(M.pillSend, async ({ to, text, images, clientMessageId }, ctx) => {
      const caller = requireUser(ctx, "send the user's words from the pill");
      if ("target" in to) {
        const entry = deps.targets === undefined ? undefined : targetEntry(deps.targets.registry, to.target);
        if (deps.targets === undefined || entry === undefined) {
          throw new MethodError(CLOVER_ERR.NOT_INSTALLED, `no pill.target entry ${to.target} is installed and active`);
        }
        if (images !== undefined && images.length > 0) throw new MethodError(ERR.INVALID_PARAMS, "a pill.target entry takes words only");
        await deps.targets.host.invoke({
          pluginId: entry.pluginId,
          handler: entry.handler,
          method: "send",
          args: { text, ...(caller.device === undefined ? {} : { device: caller.device }) },
          // The plugin's own call: what it does with the user's words is the plugin's, never the user's.
          caller: { kind: "plugin", pluginId: entry.pluginId },
        });
        return {};
      }
      let id: string;
      if ("bot" in to) {
        if (!deps.bots.has(to.bot)) throw new ContractError("not_found", `no bot ${to.bot}`);
        id = deps.bots.mainSession(to.bot);
      } else {
        id = to.session;
      }
      const refs: { n: number; path: string }[] = [];
      for (const [i, image] of (images ?? []).entries()) {
        const staged = (await call("session.stageImage")({ id, mediaType: image.mediaType, dataBase64: image.data }, ctx)) as { path: string };
        refs.push({ n: i + 1, path: staged.path });
      }
      const message = { text: withImageMarks(text, refs.length), clientMessageId, ...(refs.length > 0 ? { images: refs } : {}) };
      const sent = (await call("session.send")({ id, message }, ctx)) as { seq: number };
      return { seq: sent.seq };
    }),
  };
}
