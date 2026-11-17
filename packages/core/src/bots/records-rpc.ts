// The `bot.*` methods of bots as engine data (protocol `bots.ts`, `BOTS_METHODS`), served with records as the bots'
// source (`bots/source.ts`); with plugins as the source only `bot.move.status` is served, and the rest stay "not served
// yet". Owner: lane BT. The server checks roles, capabilities and `userOnly` before a handler runs; each handler that
// changes something checks the caller again (`requireUser`): a bot's or a plugin's call never counts as the person's.
import { BOTS_METHODS, type ChangeResult } from "@waifucave/moss-protocol";
import { ContractError } from "../contracts/common";
import type { DurableSessionHost } from "../sessions/durable-host";
import { projectRecords, readsSealed, type WireEvent } from "../sessions/wire";
import { handler, requireUser, type MethodHandler } from "../rpc/handler";
import type { PluginBotSettings } from "./plugin-bot-settings";
import type { BotService } from "./service";

export interface BotRecordMethodsDeps {
  bots: BotService;
  host: Pick<DurableSessionHost, "history" | "length">;
  /** Every plugin's bot-scoped settings for one bot, with their schema (`bot.pluginSettings`); without it, not served. */
  pluginSettingViews?: PluginBotSettings["views"];
}

const SCAN_STEP = 200;

export function botRecordMethods(deps: BotRecordMethodsDeps): Record<string, MethodHandler> {
  const { bots, host } = deps;
  const M = BOTS_METHODS;
  const status: Record<string, MethodHandler> = {
    [M.botMoveStatus.name]: handler(M.botMoveStatus, async () => bots.moveStatus()),
  };
  const store = bots.records;
  if (store === undefined) return status;
  const must = (id: string) => {
    if (!store.has(id)) throw new ContractError("not_found", `no bot ${id}`);
  };
  return {
    ...status,
    [M.botRecords.name]: handler(M.botRecords, async () => ({ bots: store.list() })),
    [M.botCreate.name]: handler(M.botCreate, async ({ name, instructions, model, effort, face }, ctx) => {
      requireUser(ctx, "make a bot");
      const bot = await bots.createBot({
        name, ...(instructions === undefined ? {} : { instructions }), ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }), ...(face === undefined ? {} : { face }),
      }, { kind: "user" });
      return { bot };
    }),
    [M.botEdit.name]: handler(M.botEdit, async ({ id, patch }, ctx): Promise<ChangeResult> => {
      requireUser(ctx, "change a bot");
      must(id);
      await bots.editBot(id, patch);
      return { applied: true };
    }),
    [M.botRemove.name]: handler(M.botRemove, async ({ id }, ctx) => {
      requireUser(ctx, "remove a bot");
      await bots.archiveBot(id);
      return { ok: true as const };
    }),
    // The person's own client only (the method is `userOnly`; checked again here): the text they are about to edit.
    [M.botInstructionsGet.name]: handler(M.botInstructionsGet, async ({ id }, ctx) => {
      requireUser(ctx, "read a bot's instructions");
      must(id);
      return { text: store.instructions(id) };
    }),
    [M.botArchived.name]: handler(M.botArchived, async () => ({ bots: bots.archivedBots() })),
    [M.botRestore.name]: handler(M.botRestore, async ({ id }, ctx) => {
      requireUser(ctx, "bring a bot back");
      return { bot: await bots.restoreBot(id) };
    }),
    // One page of a bot's one conversation, newest last: its main session's history, read back from `before` until the
    // page holds `limit` events. A reader other than the person's own app and devices gets cards without their sealed
    // parts.
    [M.botConversation.name]: handler(M.botConversation, async ({ id, before, limit }, ctx) => {
      must(id);
      const session = bots.mainSession(id);
      const opts = { kind: "bot" as const, sealed: !readsSealed(ctx.caller) };
      const length = host.length(session);
      const eventsIn = (start: number, end: number) => projectRecords(host.history(session, { afterSeq: start - 1, limit: end - start }), opts);
      let end = Math.min(before ?? length, length);
      const page: WireEvent[] = [];
      let hasMore = false;
      while (end > 0) {
        const start = Math.max(0, end - SCAN_STEP);
        const events = eventsIn(start, end);
        const need = limit - page.length;
        if (events.length > need) {
          page.unshift(...events.slice(events.length - need));
          hasMore = true;
          break;
        }
        page.unshift(...events);
        end = start;
        if (page.length === limit) {
          for (let e = end; e > 0 && !hasMore; e = Math.max(0, e - SCAN_STEP)) hasMore = eventsIn(Math.max(0, e - SCAN_STEP), e).length > 0;
          break;
        }
      }
      return { session, events: page as Record<string, unknown>[], hasMore };
    }),
    ...(deps.pluginSettingViews === undefined ? {} : {
      [M.botPluginSettings.name]: handler(M.botPluginSettings, async ({ id }) => {
        must(id);
        return { plugins: await deps.pluginSettingViews!(id) };
      }),
    }),
    [M.botSummaries.name]: handler(M.botSummaries, async () => ({ summaries: bots.summaries() })),
    [M.botMarkRead.name]: handler(M.botMarkRead, async ({ id, at }, ctx) => {
      requireUser(ctx, "mark a bot's conversation read");
      bots.markRead(id, at);
      return { ok: true as const };
    }),
  };
}
