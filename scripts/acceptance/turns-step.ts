// Turns (§5.4 "Turns"), a clause of the host API row: two folder plugins (fixtures/acceptance-turn-a and -b, each in a
// host process of its own) take the same turn, the one acceptance-turn-a offers (`contributes.turns`), and write while
// they hold it. Run side by side, their spans never overlap. Then acceptance-turn-a holds it, acceptance-turn-b waits,
// and acceptance-turn-a's host process is killed: the turn passes to acceptance-turn-b within the holder's limit, and
// the daemon's log has a line for the grant, the loss and the end. A name a plugin doesn't offer is refused.
import { cpSync } from "node:fs";
import { join } from "node:path";

export const TURNS_CLAUSE = "turns: two folder plugins take one offered turn and write only while they hold it, never at once; the holder's host process killed, the other gets it within the limit; a name not offered is refused";

/** What the clause needs of the run. */
export interface TurnsClauseDeps {
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  /** Installs a folder the user's way and presses its OK card; resolves once it runs. */
  install(folder: string, id: string): Promise<void>;
  /** Where fixtures are copied to. */
  srcDir: string;
  /** The daemon's log so far. */
  daemonLog(): string;
  fail(why: string): never;
}

const A = "acceptance-turn-a";
const B = "acceptance-turn-b";
const SLOT = `${A}/slot`;
/** The holder's limit in the kill half (`hold`'s default in the fixture). */
const HOLD_LIMIT_MS = 20_000;

type Span = { who: string; start: number; end: number };

/** Spans that overlap, in start order: each pair where the later one began before the earlier one ended. */
export function overlaps(spans: readonly Span[]): string[] {
  const sorted = [...spans].sort((x, y) => x.start - y.start);
  const out: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const before = sorted[i - 1]!;
    const now = sorted[i]!;
    if (now.start < before.end) out.push(`${now.who} began at ${now.start} before ${before.who}'s span ended at ${before.end}`);
  }
  return out;
}

/** The spans a fixture wrote in its data folder, from its `spans` command (`start`/`end` lines in pairs). */
export function spansOf(who: string, lines: readonly string[]): Span[] {
  const out: Span[] = [];
  let open: number | undefined;
  for (const l of lines) {
    const [kind, at] = l.split(" ");
    if (kind === "start") open = Number(at);
    else if (kind === "end" && open !== undefined) {
      out.push({ who, start: open, end: Number(at) });
      open = undefined;
    }
  }
  return out;
}

export async function turnsClause(d: TurnsClauseDeps): Promise<string> {
  const run = async <T>(name: string, args: unknown = {}, timeoutMs = 60_000): Promise<T> => (await d.request<{ result: T }>("command.run", { name, args }, timeoutMs)).result;
  try {
    for (const id of [A, B]) {
      const folder = join(d.srcDir, id);
      cpSync(join(import.meta.dir, "fixtures", id), folder, { recursive: true });
      await d.install(folder, id);
    }
    // Side by side, three times: each takes the slot, writes, holds it 300 ms, lets go.
    for (let i = 0; i < 3; i++) await Promise.all([run(`${A}.span`, { ms: 300 }), run(`${B}.span`, { ms: 300 })]);
    const written = [...spansOf(A, (await run<{ lines: string[] }>(`${A}.spans`)).lines), ...spansOf(B, (await run<{ lines: string[] }>(`${B}.spans`)).lines)];
    if (written.length !== 6) d.fail(`the two plugins wrote ${written.length} spans, not 6: ${JSON.stringify(written)}`);
    const crossed = overlaps(written);
    if (crossed.length > 0) d.fail(`two plugins held the turn at once: ${crossed.join("; ")}`);
    // The kill: acceptance-turn-a holds the slot; acceptance-turn-b waits for it; acceptance-turn-a's host process goes.
    const held = await run<{ at: number; until: number; pid: number }>(`${A}.hold`, { limitMs: HOLD_LIMIT_MS });
    if (typeof held.pid !== "number" || held.pid <= 1 || held.pid === process.pid) d.fail(`${A}'s hold gave no host process to kill: ${JSON.stringify(held)}`);
    const waiting = run<{ start: number; end: number }>(`${B}.span`, { ms: 100 }, HOLD_LIMIT_MS + 30_000);
    await Bun.sleep(1_000);
    const beforeKill = spansOf(B, (await run<{ lines: string[] }>(`${B}.spans`)).lines).length;
    if (beforeKill !== 3) d.fail(`${B} wrote while ${A} held the turn (${beforeKill} spans)`);
    const killedAt = Date.now();
    process.kill(held.pid, "SIGKILL");
    const got = await waiting;
    const after = got.start - killedAt;
    if (got.start >= held.until) d.fail(`${B} got the turn ${after} ms after ${A}'s host process was killed, at its limit, not because it went`);
    if (got.start < killedAt) d.fail(`${B} began at ${got.start}, before ${A}'s host process was killed at ${killedAt}`);
    // A name the other plugin doesn't offer.
    const nosy = await run<{ refused?: string; took?: boolean }>(`${B}.nosy`);
    if (nosy.refused === undefined || !nosy.refused.includes("which it doesn't offer to other plugins")) d.fail(`${B} took ${A}'s turn it doesn't offer: ${JSON.stringify(nosy)}`);
    // The daemon's log: the grant, the loss when the holder's process went, and an end.
    const log = d.daemonLog();
    for (const want of [`turns: ${SLOT} granted to ${B}`, `turns: ${SLOT} taken from ${A} (its taker went: its host process exited)`, `turns: ${SLOT} ended by ${B} (done)`]) {
      if (!log.includes(want)) d.fail(`the daemon's log has no "${want}"`);
    }
    return `${TURNS_CLAUSE}: 6 spans side by side, none overlapping; ${A}'s host process killed while it held the turn (limit ${HOLD_LIMIT_MS / 1000} s), ${B} got it ${after} ms later; "${nosy.refused.slice(0, 120)}"`;
  } finally {
    for (const id of [A, B]) await d.request("plugin.remove", { id, deleteData: true }).catch(() => undefined);
  }
}
