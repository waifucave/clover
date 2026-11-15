// The acceptance run's second speaking plugin (spec §6.6, F1's proof): everything it says, its own background part plays
// (client/index.tsx), in the device's speech turn. Its host half only tells the part what to say: a reply handed to it
// as a voice mode Clover Voice's user chose (`clover.voice.modes`' `reply`), or its own `chime`. The part reports each
// span it held the turn (`record`), which `report` answers with, so the run can prove it never overlapped Clover Voice.
// It tells its part through a stream with only its meta (`say`), once the part has said it accepts them (`ready`): a
// background part's frame loads after its plugin starts, and a stream opened before that finds no one to accept it.

type Api = { streams: { open(name: string, o: { meta: Record<string, unknown> }): Promise<{ close(): Promise<void> }> } };

let api: Api | undefined;
const said = { replies: [] as string[], spans: [] as { what: string; from: number; to: number }[] };

export function start(a: Api): void {
  api = a;
}

const need = (): Api => {
  if (api === undefined) throw new Error("the acceptance voice mode hasn't started");
  return api;
};

let ready = false;
let readied: (() => void) | undefined;
const partReady = new Promise<void>((r) => { readied = r; });

/** Tells its part what to say: a stream to it with only its meta (it reaches the background part wherever it runs),
 *  waiting up to 20 s for the part to accept them. */
async function say(what: string, seconds: number): Promise<void> {
  await Promise.race([partReady, new Promise((r) => setTimeout(r, 20_000))]);
  const w = await need().streams.open("say", { meta: { what, seconds } });
  await w.close();
}

/** Its entry on Clover Voice's voice modes: a reply to say, its own way (a 0.6 s tone). */
export async function reply(args: { bot: string; session: string; text: string }): Promise<{ ok: true }> {
  said.replies.push(args.bot);
  await say(`reply:${args.bot}`, 0.6);
  return { ok: true };
}

/** A 0.4 s tone, in its turn. */
export const chime = async () => {
  const at = Date.now();
  await say("chime", 0.4);
  return { offered: true, at };
};

/** Its `voiceModes` handler: picked as the voice, it doesn't listen (push-to-talk shows no button for it). */
export const listening = {
  listens: async () => false,
  listenStart: async () => {
    throw new Error("the acceptance voice mode doesn't listen");
  },
  listenPiece: async () => ({}),
  listenEnd: async () => undefined,
};

export const report = async () => ({ ready, replies: [...said.replies], spans: [...said.spans] });

/** Its part's own table: each span it held the device's speech turn. */
export const ui = {
  /** Its part accepts `say` now. */
  ready: async () => {
    ready = true;
    readied?.();
    return { ok: true };
  },
  record: async (args: unknown) => {
    const s = args as { what?: unknown; from?: unknown; to?: unknown } | null;
    if (typeof s?.what === "string" && typeof s.from === "number" && typeof s.to === "number") said.spans.push({ what: s.what, from: s.from, to: s.to });
    return { ok: true };
  },
};
