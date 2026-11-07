// Carrying Winter's routines and its `_assistant` memories over to Alpha (spec §12 "Existing Winter installs": Winter
// routines become Alpha's routine files on the computer they ran on, paused until the user reviews them; Alpha's
// starting memories come from `_assistant`, §14.2 item 12). Owner: lane D.
//
// * **Winter is only read** (review B2). SQLite writes beside a WAL-mode database even when it is opened read-only (its
//   `-shm`, and a `-wal` it creates), so Winter's `routines.db` is never opened where it is: it, and its `-wal` when
//   there is one (never its `-shm`, which SQLite rebuilds), are copied with plain reads into a temporary folder, and
//   the copy is opened. The memory files are read and copied, never moved. Nothing in Winter's home is written, so
//   Winter keeps working as it was (the rollback source).
// * **Routines** become files in `<home>/routines/alpha/`, one per Winter routine, each `paused: true` with a note
//   saying where it came from, so none runs before the user has looked at it. Its schedule, prompt and policy carry
//   over (the policy as a level; a raised one still needs its card). A routine Winter had switched off stays paused too.
//   Deleting `paused: true` gains a bot nothing: the file is then like any fresh routine file, at the computer's level,
//   and a raised level in it still waits for the user's card.
// * **Memories:** the `_assistant` bucket's files are copied into Alpha's memory, `home/memory/` in its tree (stored in
//   `<home>/bots/alpha/memory/`, which syncs to the user's other computers), with the seed's own rules (no links
//   followed, nothing overwritten).
// * **Once:** what was carried over is remembered (`<home>/transcripts/routines/migrated-winter.json`), so running it
//   again adds only what is new.
import { Database } from "bun:sqlite";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Level } from "@waifucave/clover-protocol";
import { seedMemory } from "../bots/memory";
import { botPaths } from "../bots/paths";
import { readJson, writeJsonAtomic } from "../sessions/atomic-file";
import { transcriptsDir } from "../sessions/ids";
import { routineFilePath } from "./engine";
import { mintRoutineId, serializeRoutine } from "./file";
import { parseSpec } from "./spec";

/** Winter's approval policies (SP-policies) as Clover's levels. */
export const WINTER_POLICY_LEVELS: Readonly<Record<string, Level>> = {
  plan: "read-only", ask: "ask", "dont-ask": "ask-risky", "accept-edits": "accept-edits", auto: "ask-risky", bypass: "automatic",
};

/** Where Winter keeps its `_assistant` memories: under its runtime home when it has one, else its home. */
export function winterAssistantMemoryDirs(winterHome: string): string[] {
  return [join(winterHome, "sdk", "projects", "_assistant", "memory"), join(winterHome, "projects", "_assistant", "memory")];
}

export interface WinterMigration {
  routines: { winterId: string; routine: string; file: string }[];
  skipped: { winterId: string; why: string }[];
  memories: number;
}

/** Copies a file with plain reads: opened read-only, not following a link, never written; the copy is new. */
function readOnlyCopy(from: string, to: string): void {
  const fd = openSync(from, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${from} isn't a file`);
    const out = openSync(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      const buf = Buffer.alloc(1024 * 1024);
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, null);
        if (n === 0) break;
        let off = 0;
        while (off < n) off += writeSync(out, buf, off, n - off);
      }
    } finally {
      closeSync(out);
    }
  } finally {
    closeSync(fd);
  }
}

function slug(text: string, taken: Set<string>): string {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "routine";
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  taken.add(name);
  return name;
}

export function migrateWinter(o: { winterHome: string; cloverHome: string; bot?: string; memories?: boolean; warn?: (m: string) => void }): WinterMigration {
  const bot = o.bot ?? "alpha";
  const out: WinterMigration = { routines: [], skipped: [], memories: 0 };
  const markerFile = join(transcriptsDir(o.cloverHome), "routines", "migrated-winter.json");
  const done = ((readJson(markerFile) as Record<string, string> | undefined) ?? {});
  const db = join(o.winterHome, "routines.db");
  if (existsSync(db)) {
    const scratch = mkdtempSync(join(tmpdir(), "clover-winter-routines-"));
    let conn: Database | undefined;
    try {
      const copy = join(scratch, "routines.db");
      readOnlyCopy(db, copy);
      if (existsSync(`${db}-wal`)) readOnlyCopy(`${db}-wal`, `${copy}-wal`);
      conn = new Database(copy);
      const rows = conn.query("SELECT id, spec, prompt, policy, cwd, enabled FROM routines ORDER BY createdAt").all() as { id: string; spec: string; prompt: string; policy: string; cwd: string; enabled: number }[];
      const taken = new Set<string>();
      for (const row of rows) {
        if (done[row.id] !== undefined) continue;
        try {
          parseSpec(row.spec);
        } catch (err) {
          out.skipped.push({ winterId: row.id, why: `its schedule "${row.spec}" doesn't read: ${err instanceof Error ? err.message : String(err)}` });
          continue;
        }
        const firstLine = row.prompt.split("\n").find((l) => l.trim() !== "")?.trim() ?? "Winter routine";
        const name = firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
        const file = routineFilePath(o.cloverHome, bot, slug(`winter-${name}`, taken));
        if (existsSync(file)) {
          out.skipped.push({ winterId: row.id, why: `${file} is there already` });
          continue;
        }
        const id = mintRoutineId();
        const level = WINTER_POLICY_LEVELS[row.policy];
        const note = [
          `> Carried over from Winter (its routine ${row.id}${row.enabled ? "" : ", which was switched off there"}). It ran in \`${row.cwd}\`.`,
          "> It waits for your review: remove `paused: true` above to let it run.",
        ].join("\n");
        mkdirSync(join(file, ".."), { recursive: true });
        writeFileSync(file, serializeRoutine({
          id, name, triggers: [{ type: "schedule", spec: row.spec }], missed: "skip", paused: true,
          ...(level === undefined ? {} : { level }),
          body: `${note}\n\n${row.prompt.trim()}`,
        }));
        done[row.id] = id;
        out.routines.push({ winterId: row.id, routine: id, file });
      }
    } finally {
      conn?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
    writeJsonAtomic(markerFile, done);
  }
  if (o.memories !== false) {
    const from = winterAssistantMemoryDirs(o.winterHome).find((d) => existsSync(d));
    if (from !== undefined) {
      const to = botPaths(o.cloverHome, bot).memory;
      mkdirSync(to, { recursive: true });
      out.memories = seedMemory(from, to, { base: o.cloverHome, ...(o.warn === undefined ? {} : { warn: o.warn }) });
    }
  }
  return out;
}
