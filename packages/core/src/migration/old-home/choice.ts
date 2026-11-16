// The person's answer to the offer, kept in the NEW home so it is asked once (ruling 2), and the mark that the home
// started empty under this build (the only home the offer is made on). "Start fresh" isn't undone from Settings: once
// the person has used a fresh home, a copy would have to merge two homes' conversations, registries and settings, which
// isn't cheap; so it is left out, and the choice stands.
import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "../../sessions/atomic-file";
import { oldHomePaths } from "./paths";

export type OldHomeChoice =
  | { v: 1; choice: "fresh"; at: number }
  | { v: 1; choice: "copied"; at: number; from: string; noticeShown?: boolean };

export function readChoice(home: string): OldHomeChoice | undefined {
  try {
    const c = JSON.parse(readFileSync(oldHomePaths(home).choice, "utf8")) as OldHomeChoice;
    return c.v === 1 && (c.choice === "fresh" || c.choice === "copied") ? c : undefined;
  } catch {
    return undefined;
  }
}

export function writeChoice(home: string, choice: OldHomeChoice): void {
  writeJsonAtomic(oldHomePaths(home).choice, choice, { mode: 0o600 });
}

/** Marks a home that started empty under this build (called at its first start, before anything is in it). */
export function markFresh(home: string, at: number): void {
  const p = oldHomePaths(home);
  if (!existsSync(p.fresh)) writeJsonAtomic(p.fresh, { v: 1, at }, { mode: 0o600 });
}

export function isFresh(home: string): boolean {
  return existsSync(oldHomePaths(home).fresh);
}
