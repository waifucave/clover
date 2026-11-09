// Where this computer keeps its own entry: its level and old names (§9.1, §8.5: levels stay on each computer). The
// file sits in the Clover home's `levels/` folder, which the fence keeps from bots (the `levels` kind, lane C's
// layout), and is written whole through a temporary file, so a crash never leaves half of it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LEVELS, COMPUTER_NAME_RE, type Level } from "@waifucave/clover-protocol";
import type { AnswerLedger } from "../contracts/approval-broker";
import type { Clock } from "../contracts/clock";
import { CARD_PROOF_MAX_AGE_MS } from "../contracts/computer-registry";
import type { SelfState, SelfStateStore } from "./registry";

/** `<Clover home>/levels/computer.json`. */
export function selfStatePath(cloverHome: string): string {
  return join(cloverHome, "levels", "computer.json");
}

export class FileSelfStateStore implements SelfStateStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  load(): SelfState {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.#path, "utf8"));
    } catch {
      return {};
    }
    const v = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const out: SelfState = {};
    if (typeof v.name === "string" && COMPUTER_NAME_RE.test(v.name)) out.name = v.name;
    if (typeof v.level === "string" && (LEVELS as readonly string[]).includes(v.level)) out.level = v.level as Level;
    if (Array.isArray(v.aliases)) out.aliases = v.aliases.filter((a): a is string => typeof a === "string" && COMPUTER_NAME_RE.test(a)).slice(0, 32);
    return out;
  }

  save(state: SelfState): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const tmp = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.#path);
  }
}

/** `<Clover home>/levels/used-cards.json`: in the fenced `levels/` folder, so a bot can't wipe it to use a card twice. */
export function usedCardsPath(cloverHome: string): string {
  return join(cloverHome, "levels", "used-cards.json");
}

/** `<Clover home>/levels/used-answers.json`: the card ids of the signed answers this computer took as proof (another
 *  computer's call, a raise from elsewhere), in the same fenced folder. */
export function usedAnswersPath(cloverHome: string): string {
  return join(cloverHome, "levels", "used-answers.json");
}

/** The most card ids kept; past it (after pruning) a claim is refused, never a used id forgotten. */
const USED_CARDS_MAX = 4096;

/** The card ids a level raise `via: "card"`, or another computer's signed answer, has used (#342 review, item 3), on
 *  disk so a card counts once across a restart too. An id is kept twice the age bound (`CARD_PROOF_MAX_AGE_MS`, which
 *  a signed answer's freshness shares) from its use: after that the bound refuses the card anyway. Fails closed: when
 *  the file can't be written, the claim is refused; and when it is there but can't be read (corrupt, #368's review),
 *  every claim is refused until twice the bound has passed since this start, so no id it held can count again, and
 *  only then is it written afresh. A missing file is an empty record. */
export class FileAnswerLedger implements AnswerLedger {
  readonly #path: string;
  readonly #clock: Pick<Clock, "now">;
  readonly #used = new Map<string, number>();
  /** When a file that couldn't be read was found: claims are refused until the ids it held are too old to count. */
  #brokenSince: number | undefined;

  constructor(path: string, clock: Pick<Clock, "now">) {
    this.#path = path;
    this.#clock = clock;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.#brokenSince = clock.now();
      return;
    }
    let used: unknown;
    try {
      const raw = JSON.parse(text) as unknown;
      used = typeof raw === "object" && raw !== null ? (raw as { used?: unknown }).used : undefined;
    } catch {
      used = undefined;
    }
    if (typeof used !== "object" || used === null || Array.isArray(used)) {
      this.#brokenSince = clock.now();
      return;
    }
    for (const [id, at] of Object.entries(used)) if (typeof at === "number" && Number.isFinite(at)) this.#used.set(id, at);
  }

  claim(cardId: string): boolean {
    const now = this.#clock.now();
    if (this.#brokenSince !== undefined) {
      if (now - this.#brokenSince <= 2 * CARD_PROOF_MAX_AGE_MS) return false;
      this.#brokenSince = undefined;
    }
    if (this.#used.has(cardId)) return false;
    for (const [id, at] of this.#used) if (now - at > 2 * CARD_PROOF_MAX_AGE_MS) this.#used.delete(id);
    if (this.#used.size >= USED_CARDS_MAX) return false;
    this.#used.set(cardId, now);
    try {
      mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
      const tmp = `${this.#path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ used: Object.fromEntries(this.#used) })}\n`, { mode: 0o600 });
      renameSync(tmp, this.#path);
    } catch {
      // Not on disk, so not used: the id stays taken in memory (this run), but the raise is refused.
      return false;
    }
    return true;
  }
}
