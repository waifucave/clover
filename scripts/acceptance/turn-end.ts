// When the turn a message started has ended, read from the session's events (the protocol's `session.send` returns only
// a seq: no turn or message id to match on). A user's message to a bot's main conversation interrupts the turn running
// there (its `turn_completed`, aborted, lands after the send's seq), and any other turn of the bot (a routine's, a reply
// the daemon finished at its start) may end after it too: the first `turn_completed` after the seq is not proof. The
// turn of this message is the first `turn_started` after its own `user_message` (the one at or after the send's seq,
// with its text when known); it has ended at the first `turn_completed` after that start.
export type TurnEv = { type?: unknown; seq?: unknown; text?: unknown; [k: string]: unknown };

const seqOf = (e: TurnEv): number => (typeof e.seq === "number" ? e.seq : -1);

/** The message's own `user_message`: the first at or after `sentSeq` whose text is `text` (any, when `text` is absent or
 *  none matches: the daemon may store the message's words differently). */
export function ownUserMessage(events: readonly TurnEv[], sentSeq: number, text?: string): TurnEv | undefined {
  const mine = events.filter((e) => e.type === "user_message" && seqOf(e) >= sentSeq).sort((a, b) => seqOf(a) - seqOf(b));
  return (text === undefined ? undefined : mine.find((e) => e.text === text)) ?? mine[0];
}

/** Whether the turn the message sent at `sentSeq` started has ended: its `turn_completed`, else undefined. */
export function ownTurnCompleted(events: readonly TurnEv[], sentSeq: number, text?: string): TurnEv | undefined {
  const msg = ownUserMessage(events, sentSeq, text);
  if (msg === undefined) return undefined;
  const sorted = [...events].sort((a, b) => seqOf(a) - seqOf(b));
  const started = sorted.find((e) => e.type === "turn_started" && seqOf(e) > seqOf(msg));
  if (started === undefined) return undefined;
  return sorted.find((e) => e.type === "turn_completed" && seqOf(e) > seqOf(started));
}

/** The events of the turn the message started, from its `turn_started` to its `turn_completed`, once it has ended. */
export function ownTurnEvents<E extends TurnEv>(events: readonly E[], sentSeq: number, text?: string): E[] | undefined {
  const msg = ownUserMessage(events, sentSeq, text);
  const done = ownTurnCompleted(events, sentSeq, text);
  if (msg === undefined || done === undefined) return undefined;
  const started = [...events].sort((a, b) => seqOf(a) - seqOf(b)).find((e) => e.type === "turn_started" && seqOf(e) > seqOf(msg))!;
  return events.filter((e) => seqOf(e) >= seqOf(started) && seqOf(e) <= seqOf(done)).sort((a, b) => seqOf(a) - seqOf(b));
}
