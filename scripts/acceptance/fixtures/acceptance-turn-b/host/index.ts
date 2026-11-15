// The turns clause's fixture (§5.4 "Turns"), the twin of acceptance-turn-a: it takes acceptance-turn-a's offered turn
// `slot` the same ways (`span`, `hold`, `spans`), and `nosy` tries `private`, a name acceptance-turn-a doesn't offer.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SLOT = "acceptance-turn-a/slot"; // the other plugin's, which it offers
type Turn = { id: string; until: number; done(): Promise<void>; lost: Promise<string> };
type Api = { storage: { dataFolder: string }; turns: { take(name: string, o?: { limitMs?: number; note?: string }): Promise<Turn> } };
let api: Api | undefined;
const kept: Turn[] = [];

export function start(a: Api): void {
  api = a;
}

const need = (): Api => {
  if (api === undefined) throw new Error("not started");
  return api;
};
const file = () => join(need().storage.dataFolder, "spans.log");

export async function span(args: { ms?: number } | null): Promise<Record<string, unknown>> {
  const turn = await need().turns.take(SLOT, { limitMs: 20_000, note: "a span" });
  const start = Date.now();
  appendFileSync(file(), `start ${start}\n`);
  await Bun.sleep(typeof args?.ms === "number" ? args.ms : 300);
  const end = Date.now();
  appendFileSync(file(), `end ${end}\n`);
  await turn.done();
  return { start, end };
}

export async function hold(args: { limitMs?: number } | null): Promise<Record<string, unknown>> {
  const turn = await need().turns.take(SLOT, { limitMs: typeof args?.limitMs === "number" ? args.limitMs : 20_000, note: "held" });
  kept.push(turn);
  const at = Date.now();
  appendFileSync(file(), `held ${at}\n`);
  return { at, until: turn.until, pid: process.pid };
}

export function spans(): Record<string, unknown> {
  return { lines: existsSync(file()) ? readFileSync(file(), "utf8").trim().split("\n").filter(Boolean) : [] };
}

export async function nosy(): Promise<Record<string, unknown>> {
  try {
    const turn = await need().turns.take("acceptance-turn-a/private", { limitMs: 1_000 });
    await turn.done();
    return { took: true };
  } catch (e) {
    return { refused: e instanceof Error ? e.message : String(e) };
  }
}
