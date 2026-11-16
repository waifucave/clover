// The swap: a whole staged copy (`copy.ts`) taken into the home at a start, under the home's lock, before any store
// opens. Each top-level entry of the staging folder replaces the fresh home's entry of that name; what the fresh home
// held there is set aside in `migration/old-home/replaced/<when>/`, never deleted. What the fresh home's own engine
// made and the copy never stages stays as it is: its run files, logs, secret store index, device registry and signed
// plugin registry (`LEFT_OUT_TOP`), and the copy's own records. `migration/` is merged file by file (only Migration C's
// layout mark is staged).
//
// A journal lists the entries before the first one moves, and each step can be done again: a start cut short during
// the swap finishes it at the next start. A staging folder with no completion mark is a copy cut short: it is removed,
// the home is as it was, and the offer is made again.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonAtomic } from "../../sessions/atomic-file";
import { writeChoice } from "./choice";
import { stagedReport } from "./copy";
import { oldHomePaths } from "./paths";

interface Journal {
  v: 1;
  at: number;
  from: string;
  entries: string[];
}

export type SwapResult = { kind: "none" } | { kind: "discarded" } | { kind: "swapped"; from: string; entries: string[] };

function filesUnder(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel === "" ? e.name : join(rel, e.name);
    if (e.isDirectory()) out.push(...filesUnder(dir, r));
    else out.push(r);
  }
  return out;
}

/** Finishes or discards a staged copy (see the file's header). Never throws for a missing piece; a rename that fails
 *  throws, and the journal makes the next start try again. */
export function applyStagedCopy(home: string, o: { now?: () => number; log?: (line: string) => void } = {}): SwapResult {
  const p = oldHomePaths(home);
  const log = o.log ?? (() => {});
  const now = o.now ?? Date.now;
  let journal: Journal | undefined;
  if (existsSync(p.journal)) {
    journal = JSON.parse(readFileSync(p.journal, "utf8")) as Journal;
    log(`old home: finishing the swap a start left part done (${journal.entries.length} entries)`);
  } else if (existsSync(p.staging)) {
    if (!existsSync(p.complete)) {
      rmSync(p.staging, { recursive: true, force: true });
      rmSync(p.scratch, { recursive: true, force: true });
      log("old home: a copy that didn't finish was removed; this home is as it was, and the copy is offered again");
      return { kind: "discarded" };
    }
    const report = stagedReport(home);
    journal = { v: 1, at: now(), from: report?.from ?? "", entries: readdirSync(p.staging).sort() };
    writeJsonAtomic(p.journal, journal, { mode: 0o600 });
  } else {
    return { kind: "none" };
  }
  const aside = join(p.replaced, String(journal.at));
  for (const entry of journal.entries) {
    const staged = join(p.staging, entry);
    const target = join(home, entry);
    if (entry === "migration") {
      if (!existsSync(staged)) continue;
      for (const f of filesUnder(staged)) {
        const to = join(target, f);
        mkdirSync(dirname(to), { recursive: true });
        if (present(to)) {
          mkdirSync(dirname(join(aside, entry, f)), { recursive: true });
          renameSync(to, join(aside, entry, f));
        }
        renameSync(join(staged, f), to);
      }
      rmSync(staged, { recursive: true, force: true });
      continue;
    }
    if (!existsSync(staged)) continue; // moved by the start that was cut short
    if (present(target)) {
      mkdirSync(aside, { recursive: true });
      renameSync(target, join(aside, entry));
    }
    renameSync(staged, target);
  }
  rmSync(p.staging, { recursive: true, force: true });
  writeChoice(home, { v: 1, choice: "copied", at: journal.at, from: journal.from });
  rmSync(p.journal, { force: true });
  log(`old home: the copy from ${journal.from} is in place (${journal.entries.length} entries; what this home held there is kept in ${aside})`);
  return { kind: "swapped", from: journal.from, entries: journal.entries };
}

/** Whether anything is at `path`, a dangling link included. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
