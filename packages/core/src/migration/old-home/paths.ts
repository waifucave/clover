// Where the one-time copy keeps its own records in the NEW home: `<home>/migration/old-home/`. Nothing copied from the
// old home lands here (the copy takes only Migration C's layout mark from the old `migration/`), so the old records
// can't collide with these.
import { join } from "node:path";

export interface OldHomePaths {
  dir: string;
  /** The user's answer, kept so the offer is made once (`choice.ts`). */
  choice: string;
  /** This home started empty under this build: the only home the offer is made on. */
  fresh: string;
  /** The copy as it is made; swapped in at the next start once `complete` is written. */
  staging: string;
  /** Written last by the copy: the staging folder is whole. Holds the copy's report. */
  complete: string;
  /** The swap's journal, so a start cut short during the swap finishes it. */
  journal: string;
  /** What the fresh home held where the copy took its place, set aside, never deleted. */
  replaced: string;
  /** The registry's records to write through its own signed store when it opens (`carry.ts`). */
  carry: string;
  /** What did not come over, for the notice (`left-behind.ts`). */
  leftBehind: string;
  /** The SQLite files' raw copies, read by SQLite to make the staged databases; removed after. */
  scratch: string;
}

export function oldHomePaths(home: string): OldHomePaths {
  const dir = join(home, "migration", "old-home");
  return {
    dir,
    choice: join(dir, "choice.json"),
    fresh: join(dir, "fresh.json"),
    staging: join(dir, "staging"),
    complete: join(dir, "staging.complete.json"),
    journal: join(dir, "swap.journal.json"),
    replaced: join(dir, "replaced"),
    carry: join(dir, "carry.json"),
    leftBehind: join(dir, "left-behind.json"),
    scratch: join(dir, "scratch"),
  };
}
