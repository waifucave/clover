// The acceptance run's second speaking plugin (spec §6.6, F1's proof): everything it says, its own background part plays
// (client/index.tsx), in the device's speech turn. Its host half only tells the part what to say: a reply handed to it
// as a voice mode Clover Voice's user chose (`clover.voice.modes`' `reply`), or its own `chime`. The part reports each
// span it held the turn (`record`), which `report` answers with, so the run can prove it never overlapped Clover Voice.

type Api = { ui: { send(event: string, data?: unknown): void } };

let api: Api | undefined;
const said = { replies: [] as string[], spans: [] as { what: string; from: number; to: number }[] };

export function start(a: Api): void {
  api = a;
}

const need = (): Api => {
  if (api === undefined) throw new Error("the acceptance voice mode hasn't started");
  return api;
};

/** Its entry on Clover Voice's voice modes: a reply to say, its own way (a 0.6 s tone). */
export async function reply(args: { bot: string; session: string; text: string }): Promise<{ ok: true }> {
  said.replies.push(args.bot);
  need().ui.send("say", { what: `reply:${args.bot}`, seconds: 0.6 });
  return { ok: true };
}

/** A 0.4 s tone, in its turn. */
export const chime = async () => {
  need().ui.send("say", { what: "chime", seconds: 0.4 });
  return { offered: true, at: Date.now() };
};

export const report = async () => ({ replies: [...said.replies], spans: [...said.spans] });

/** Its part's own table: each span it held the device's speech turn. */
export const ui = {
  record: async (args: unknown) => {
    const s = args as { what?: unknown; from?: unknown; to?: unknown } | null;
    if (typeof s?.what === "string" && typeof s.from === "number" && typeof s.to === "number") said.spans.push({ what: s.what, from: s.from, to: s.to });
    return { ok: true };
  },
};
