// A plugin's notifications (`notify.send`, spec §10; the controller's ruling of 2026-11-11), and the desktop door the
// bundled notifier shows them through (`desktop.show`, `desktop.close`). One service on this computer:
//
// * **`notify.send`** (the plugin API, from its host half or its UI layer alike: one handler) needs the `notify`
//   capability, which the router checks against what the user OK'd and the OK card names. In order:
//   1. a plugin the user muted (Settings; `notify.setMuted`, the user's own choice in `<home>/settings/
//      notifications.json`, which no plugin reaches) is refused, and no notifier sees it;
//   2. while an approval card waits on this computer, it is refused: a plugin's banner never sits over a sealed card
//      (and one already up is closed when a card arrives, below);
//   3. at most `NOTIFY_PER_MINUTE` a minute and `NOTIFY_PER_HOUR` an hour per plugin, its host half and its layer
//      counted together; one past that is refused, with when to try again;
//   4. then every active `notifiers` entry is handed a `notification` update: the title and body (cut to 120 and 400
//      characters, on one line), and the sender as the registry knows it (its id, its manifest's name, whether it is
//      the bundled `clover` tree's), never as the plugin said. The plugin's `session` isn't taken: no plugin names
//      where a click goes.
// * **The notifiers** are called one update at a time each; while one's `notify` runs, a newer update replaces the
//   one waiting (`NotifierUpdate.seq`), so a notifier may see gaps and always ends on the latest.
// * **The desktop door** (`PluginApi.desktop`, the bundled `clover` tree's process only: the router refuses it to any
//   other plugin) sends `app.notify` and `app.notify.close` to this computer's app. Its banners have no buttons: a
//   click only brings the app forward. A banner shown for a plugin's notification is closed when a card arrives, and
//   none is shown while one waits. Ids are kept apart per notifier plugin.
//
// What it doesn't do yet (named in the capability matrix): the core's own updates (a message, a card, a question, a
// routine's result, an agent finishing) don't reach the notifiers, and a `runsOn: "each"` notifier is called on this
// computer only.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NOTIFY_PER_HOUR, NOTIFY_PER_MINUTE, type NotifierUpdate } from "@waifucave/clover-plugin-sdk";
import { APP_METHODS, topPluginIdOf } from "@waifucave/clover-protocol";
import { handler, type MethodHandler } from "../rpc/handler";
import type { ApprovalBroker } from "../contracts/approval-broker";
import type { Clock } from "../contracts/clock";
import { ContractError, type Unsubscribe } from "../contracts/common";
import type { ApiHandlers } from "../plugin-host/api/router";
import type { ApiRouter, PluginHost } from "../contracts/plugin-host";
import type { PluginRegistry } from "../contracts/plugin-registry";

/** Quotation marks of every script (straight and curly, guillemets, CJK corner brackets, fullwidth). */
export const NAME_QUOTES = /[\p{Pi}\p{Pf}"'`\u00ab\u00bb\u2018-\u201f\u2039\u203a\u2e42\u300c-\u300f\u301d-\u301f\ufe41-\ufe44\uff02\uff07\uff62\uff63]/gu;

/** What a notification's words may hold once cut: one line each. */
export const NOTIFY_TITLE_MAX = 120;
export const NOTIFY_BODY_MAX = 400;

/** This computer's app, as the door reaches it: fire-and-forget, `false` when no app is connected here. */
export interface DesktopPort {
  notify(params: { id: string; title: string; body?: string; session?: string; urgent?: boolean; silent?: boolean }): boolean;
  close(id?: string): void;
}

export interface NotifyServiceOptions {
  home: string;
  computer: string;
  clock: Pick<Clock, "now">;
  registry: Pick<PluginRegistry, "get" | "entries">;
  host: Pick<PluginHost, "invoke">;
  approvals?: Pick<ApprovalBroker, "pending" | "watch">;
  desktop?: DesktopPort;
  log?: (line: string) => void;
}

export function notifyMutesFile(home: string): string {
  return join(home, "settings", "notifications.json");
}

export function readNotifyMutes(home: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(notifyMutesFile(home), "utf8")) as { muted?: unknown };
    return Array.isArray(raw.muted) ? raw.muted.filter((x): x is string => typeof x === "string").slice(0, 1024) : [];
  } catch {
    return [];
  }
}

/** Mutes or unmutes a plugin (`notify.setMuted`, the user's own call). */
export function writeNotifyMute(home: string, pluginId: string, muted: boolean): void {
  const now = new Set(readNotifyMutes(home));
  if (muted) now.add(pluginId);
  else now.delete(pluginId);
  const file = notifyMutesFile(home);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify({ muted: [...now].sort() }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** `notify.mutes` and `notify.setMuted`: the user's alone (the app, the CLI), never a plugin's or a bot's. */
export function notifyMuteMethods(o: { home: string }): Record<string, MethodHandler> {
  const M = APP_METHODS;
  const userOnly = (ctx: { caller: { kind: string } }) => {
    if (ctx.caller.kind !== "user") throw new ContractError("refused", "only you choose which plugins may notify you");
  };
  return {
    [M.notifyMutes.name]: handler(M.notifyMutes, (_p, ctx) => (userOnly(ctx), { muted: readNotifyMutes(o.home) })),
    [M.notifySetMuted.name]: handler(M.notifySetMuted, ({ pluginId, muted }, ctx) => {
      userOnly(ctx);
      writeNotifyMute(o.home, pluginId, muted);
      return { ok: true as const };
    }),
  };
}

/** `notify.send` from a plugin's UI layer, on its own connection: the plugin is the connection's (its token's), and the
 *  call goes through the plugin API's router as its host half's does (the `notify` capability, the same rules, the
 *  same rate). */
export function notifyLayerMethods(router: ApiRouter): Record<string, MethodHandler> {
  const M = APP_METHODS;
  return {
    [M.notifySend.name]: handler(M.notifySend, async (p, ctx) => {
      if (ctx.caller.kind !== "plugin") throw new ContractError("refused", "only a plugin sends a notification this way");
      const pluginId = ctx.caller.pluginId;
      await router({ pluginId, process: "ui", path: "notify.send", args: [p], caller: { kind: "plugin", pluginId } });
      return { ok: true as const };
    }),
  };
}

/** One line, no control or direction marks, cut to `max` with an ellipsis. */
export function notifyLine(text: string, max: number): string {
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁦-⁩﻿]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

interface Lane {
  running: boolean;
  waiting?: NotifierUpdate;
  /** The update its current `notify` call is for. */
  current?: NotifierUpdate;
}

export class NotifyService {
  readonly #o: NotifyServiceOptions;
  #seq = 0;
  /** Each plugin's sends in the last hour (shared time), oldest first. */
  readonly #sent = new Map<string, number[]>();
  /** Each notifier plugin's queue. */
  readonly #lanes = new Map<string, Lane>();
  /** Door ids shown for a plugin's notification, closed when a card arrives. */
  readonly #pluginBanners = new Set<string>();
  /** Every door id shown, by the notifier plugin that showed it. */
  readonly #shownBy = new Map<string, Set<string>>();
  readonly #unwatch: Unsubscribe | undefined;

  constructor(o: NotifyServiceOptions) {
    this.#o = o;
    this.#unwatch = o.approvals?.watch((e) => {
      // Any card the app shows: it may sit on any computer's card list, and the banner is this computer's.
      if (e.type !== "requested") return;
      for (const id of this.#pluginBanners) o.desktop?.close(id);
      this.#pluginBanners.clear();
    });
  }

  close(): void {
    this.#unwatch?.();
  }

  muted(): string[] {
    return readNotifyMutes(this.#o.home);
  }

  #cardWaiting(): boolean {
    return (this.#o.approvals?.pending().length ?? 0) > 0;
  }

  /** `notify.send` for `pluginId` (the router's: the plugin is the call's, never a parameter). */
  send(pluginId: string, raw: unknown): { ok: true } {
    const n = (raw ?? {}) as { title?: unknown; body?: unknown };
    if (typeof n.title !== "string" || n.title.trim() === "") throw new ContractError("invalid", "notify.send needs a title");
    if (n.body !== undefined && typeof n.body !== "string") throw new ContractError("invalid", "a notification's body is text");
    const top = topPluginIdOf(pluginId);
    const mutes = this.muted();
    if (mutes.includes(pluginId) || mutes.includes(top)) throw new ContractError("refused", `${pluginId}'s notifications are muted in Settings`);
    if (this.#cardWaiting()) throw new ContractError("refused", "an approval card is waiting on this computer; a plugin's notification can't show over it, try again once it is answered");
    const now = this.#o.clock.now();
    const sent = (this.#sent.get(top) ?? []).filter((t) => now - t < 3_600_000);
    const lastMinute = sent.filter((t) => now - t < 60_000);
    if (lastMinute.length >= NOTIFY_PER_MINUTE) {
      const wait = Math.ceil((60_000 - (now - lastMinute[0]!)) / 1000);
      throw new ContractError("refused", `${pluginId} sent ${NOTIFY_PER_MINUTE} notifications this minute; at most ${NOTIFY_PER_MINUTE} a minute (try again in ${wait} s)`);
    }
    if (sent.length >= NOTIFY_PER_HOUR) throw new ContractError("refused", `${pluginId} sent ${NOTIFY_PER_HOUR} notifications this hour; at most ${NOTIFY_PER_HOUR} an hour`);
    sent.push(now);
    this.#sent.set(top, sent);
    const record = this.#o.registry.get(pluginId);
    // No quotation marks of any script: a notifier puts the name in quotes, and a name must not close them.
    const name = notifyLine((typeof record?.name === "string" && record.name !== "" ? record.name : pluginId).replace(NAME_QUOTES, ""), 80) || pluginId;
    const update: NotifierUpdate = {
      seq: ++this.#seq, kind: "notification", unseen: 0, at: now,
      notification: { title: notifyLine(n.title, NOTIFY_TITLE_MAX), ...(typeof n.body === "string" && notifyLine(n.body, NOTIFY_BODY_MAX) !== "" ? { body: notifyLine(n.body, NOTIFY_BODY_MAX) } : {}) },
      sender: { pluginId, name, bundled: top === "clover" && record?.source === "bundled" },
    };
    this.#dispatch(update);
    return { ok: true };
  }

  /** Hands an update to every active notifier, one call at a time each, latest wins while one runs. */
  #dispatch(update: NotifierUpdate): void {
    for (const e of this.#o.registry.entries("notifiers")) {
      if (e.state !== "active") continue;
      const handler = (e.value as { handler?: unknown } | null)?.handler;
      if (typeof handler !== "string") continue;
      const key = `${e.pluginId}\u0000${handler}`;
      const lane = this.#lanes.get(key) ?? { running: false };
      this.#lanes.set(key, lane);
      lane.waiting = update;
      if (!lane.running) void this.#drain(lane, e.pluginId, handler);
    }
  }

  async #drain(lane: Lane, pluginId: string, handler: string): Promise<void> {
    lane.running = true;
    try {
      while (lane.waiting !== undefined) {
        const update = lane.waiting;
        lane.waiting = undefined;
        lane.current = update;
        try {
          await this.#o.host.invoke({ pluginId, handler, method: "notify", args: update, caller: { kind: "plugin", pluginId } });
        } catch (err) {
          // A notifier that fails is worth a line, never the notification's words.
          this.#o.log?.(`[notify] ${pluginId}'s notifier didn't take update ${update.seq}: ${err instanceof Error ? err.name : "error"}`);
        }
      }
    } finally {
      lane.current = undefined;
      lane.running = false;
    }
  }

  /** Whether the notifier `pluginId` is now handling a plugin's notification (its desktop calls are for one). */
  #forPluginNotification(pluginId: string): boolean {
    for (const [key, lane] of this.#lanes) if (key.startsWith(`${pluginId}\u0000`) && lane.current?.kind === "notification") return true;
    return false;
  }

  /** The door's id for a notifier's banner: its plugin's, so two notifiers never replace each other's. */
  static doorId(pluginId: string, id: string): string {
    return `${pluginId}:${id}`.slice(0, 128);
  }

  /** The plugin API handlers: `notify.send` and the desktop door. */
  apiHandlers(): ApiHandlers {
    return {
      "notify.send": (ctx, args) => this.send(ctx.pluginId, args[0]),
      "desktop.show": (ctx, args) => {
        const b = (args[0] ?? {}) as { id?: unknown; title?: unknown; body?: unknown; session?: unknown; urgent?: unknown; silent?: unknown };
        if (typeof b.id !== "string" || b.id === "" || typeof b.title !== "string") throw new ContractError("invalid", "desktop.show needs an id and a title");
        const forPlugin = this.#forPluginNotification(ctx.pluginId);
        if (forPlugin && this.#cardWaiting()) return { shown: false };
        const id = NotifyService.doorId(ctx.pluginId, b.id);
        const shown = this.#o.desktop?.notify({
          id, title: notifyLine(b.title, 256),
          ...(typeof b.body === "string" && b.body !== "" ? { body: b.body.slice(0, 4000) } : {}),
          // A plugin's notification never says where a click goes; the core's own updates may.
          ...(!forPlugin && typeof b.session === "string" && b.session !== "" ? { session: b.session } : {}),
          ...(b.urgent === true ? { urgent: true } : {}), ...(b.silent === true ? { silent: true } : {}),
        }) ?? false;
        if (shown) {
          const mine = this.#shownBy.get(ctx.pluginId) ?? new Set<string>();
          mine.add(id);
          this.#shownBy.set(ctx.pluginId, mine);
          if (forPlugin) this.#pluginBanners.add(id);
        }
        return { shown };
      },
      "desktop.close": (ctx, args) => {
        const id = args[0];
        if (id === undefined) {
          // Every banner this notifier showed, by id: never another notifier's.
          for (const known of this.#shownBy.get(ctx.pluginId) ?? []) {
            this.#pluginBanners.delete(known);
            this.#o.desktop?.close(known);
          }
          this.#shownBy.delete(ctx.pluginId);
          return undefined;
        }
        if (typeof id !== "string") throw new ContractError("invalid", "desktop.close takes a banner's id");
        const door = NotifyService.doorId(ctx.pluginId, id);
        this.#pluginBanners.delete(door);
        this.#shownBy.get(ctx.pluginId)?.delete(door);
        this.#o.desktop?.close(door);
        return undefined;
      },
    };
  }
}
