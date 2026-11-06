// Where this computer keeps its own entry: its level and old names (§9.1, §8.5: levels stay on each computer). The
// file sits in the Clover home's `levels/` folder, which the fence keeps from bots (the `levels` kind, lane C's
// layout), and is written whole through a temporary file, so a crash never leaves half of it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LEVELS, COMPUTER_NAME_RE, type Level } from "@waifucave/clover-protocol";
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
