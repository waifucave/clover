// The core's own updates for the notifiers (spec §10; `NotifierUpdate.kind`): what happened in a bot's conversation that
// the user hasn't seen, handed to every `notifiers` entry through `NotifyService.core`. Watches the bot side's session
// host live (nothing replayed: a daemon boot raises no banner for what happened before it):
//
// * a bot's turn the user didn't start ends normally (origin `bot`, `agent`, `plugin` or `peer`)      -> `message`
// * an agent's report reaches the bot's conversation (a `task-notification` input)                      -> `agent-finished`
// * a routine's result is posted into the bot's conversation (a `routine` input; `failed` as it says)   -> `routine-result`
// * a card or a question now waits in a conversation (`needsYou` went up)                                -> `card`, `question`
// * the user answers in it (their message, a card or a question taken off)                              -> `answered`: the count
//   starts again and the notifiers' banners go.
//
// A turn the user started is not announced (they are waiting for it, and the app shows it), nor are the turns a routine's
// result or an agent's report start (their own kinds said it). No text of any message, card or question is read.
import type { Unsubscribe } from "../contracts/common";
import type { SessionView } from "@waifucave/clover-protocol";
import type { SessionHost, SessionRecord } from "../contracts/session-host";
import type { NotifierUpdate } from "@waifucave/clover-plugin-sdk";

export interface CoreNoticeSink {
  core(update: { kind: Exclude<NotifierUpdate["kind"], "notification">; bot?: string; session?: string; failed?: boolean }): void;
  answered(bot: string): void;
}

/** The origins whose turn's end is a bot's message to the user. */
const MESSAGE_ORIGINS: ReadonlySet<string> = new Set(["bot", "agent", "plugin", "peer"]);

interface Followed {
  bot: string;
  off: Unsubscribe;
  origin?: string;
  cards: number;
  questions: number;
}

export class CoreNotices {
  readonly #followed = new Map<string, Followed>();
  readonly #offWatch: Unsubscribe;

  constructor(private readonly o: { host: Pick<SessionHost, "watch" | "list" | "subscribe">; sink: CoreNoticeSink; log?: (line: string) => void }) {
    this.#offWatch = o.host.watch((view) => this.#view(view));
    for (const view of o.host.list({ kind: "bot" })) this.#view(view);
  }

  close(): void {
    this.#offWatch();
    for (const f of this.#followed.values()) f.off();
    this.#followed.clear();
  }

  #view(view: SessionView): void {
    // Only a bot's own conversation: a side thread, an agent or a coding session has its own door (their reports come
    // to the bot's conversation as inputs).
    if (view.kind !== "bot" || view.bot === undefined) return;
    let f = this.#followed.get(view.id);
    if (f === undefined) {
      try {
        const off = this.o.host.subscribe(view.id, (record) => this.#record(view.id, record));
        f = { bot: view.bot, off, cards: view.needsYou?.cards ?? 0, questions: view.needsYou?.questions ?? 0 };
      } catch (err) {
        this.o.log?.(`[notify] not following ${view.id}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      this.#followed.set(view.id, f);
      return;
    }
    const cards = view.needsYou?.cards ?? 0;
    const questions = view.needsYou?.questions ?? 0;
    if (cards > f.cards) this.o.sink.core({ kind: "card", bot: f.bot, session: view.id });
    if (questions > f.questions) this.o.sink.core({ kind: "question", bot: f.bot, session: view.id });
    // Something taken off (answered, withdrawn, timed out): the user has caught up with it.
    if (cards < f.cards || questions < f.questions) this.o.sink.answered(f.bot);
    f.cards = cards;
    f.questions = questions;
  }

  #record(id: string, record: SessionRecord): void {
    const f = this.#followed.get(id);
    if (f === undefined) return;
    switch (record.type) {
      case "input": {
        const input = record.input;
        if (input.from === "user") this.o.sink.answered(f.bot);
        else if (input.from === "task-notification") this.o.sink.core({ kind: "agent-finished", bot: f.bot, session: id });
        else if (input.from === "routine") this.o.sink.core({ kind: "routine-result", bot: f.bot, session: id, ...(input.failed === undefined ? {} : { failed: input.failed }) });
        return;
      }
      case "turn_started":
        f.origin = record.origin;
        return;
      case "turn_ended":
        if (record.end.reason === "end_turn" && f.origin !== undefined && MESSAGE_ORIGINS.has(f.origin)) this.o.sink.core({ kind: "message", bot: f.bot, session: id });
        f.origin = undefined;
        return;
      default:
        return;
    }
  }
}
