// Saved rules on disk: `<home>/rules/saved-rules.json`, inside the fenced set (`saved-rules`), so no bot, agent or
// plugin can write itself an "always". Each rule is a hash of its key and a scrubbed display string, never the raw
// key (#267's ruling 4). Written whole and owner-only: the folder is made and chmodded 0700, the file goes through a
// new temporary file created exclusively without following a link (`O_CREAT | O_EXCL | O_NOFOLLOW`) and a rename, and
// is read back without following a link and strictly, so a damaged file loads as no rules (every call asks again)
// rather than as rules no one saved.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { RuleStore, StoredRule } from "./broker";

/** The file's format; a file of another version is read as unreadable (no rules). */
export const SAVED_RULES_VERSION = 2;
/** The largest saved-rules file read back. */
const MAX_BYTES = 8 * 1024 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export function savedRulesPath(cloverHome: string): string {
  return join(cloverHome, "rules", "saved-rules.json");
}

const isRule = (r: unknown): r is StoredRule => {
  const o = r as Partial<StoredRule> | null;
  return typeof o === "object" && o !== null && typeof o.keyHash === "string" && /^[0-9a-f]{64}$/.test(o.keyHash)
    && typeof o.display === "string" && Array.isArray(o.computers) && o.computers.length > 0
    && o.computers.every((c) => typeof c === "string" && c !== "") && typeof o.cardId === "string" && typeof o.savedAt === "number"
    && (o.bot === undefined || (typeof o.bot === "string" && o.bot !== ""));
};

function readNoFollow(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("saved rules can't be opened");
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_BYTES) throw new Error("saved rules aren't a file this broker wrote");
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, n);
      if (got === 0) break;
      n += got;
    }
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function fileRuleStore(cloverHome: string): RuleStore {
  const dir = join(cloverHome, "rules");
  const path = savedRulesPath(cloverHome);
  return {
    load() {
      const text = readNoFollow(path);
      if (text === undefined) return [];
      const doc = JSON.parse(text) as { version?: unknown; rules?: unknown };
      if (doc.version !== SAVED_RULES_VERSION || !Array.isArray(doc.rules) || !doc.rules.every(isRule)) throw new Error("saved rules aren't ones this broker wrote");
      return doc.rules.map((r) => ({ keyHash: r.keyHash, display: r.display, computers: [...r.computers], cardId: r.cardId, savedAt: r.savedAt, ...(r.bot === undefined ? {} : { bot: r.bot }) }));
    },
    save(rules) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (lstatSync(dir).isSymbolicLink()) throw new Error("the rules folder is a link");
      if (process.platform !== "win32") chmodSync(dir, 0o700);
      const doc = { version: SAVED_RULES_VERSION, rules: rules.map((r) => ({ keyHash: r.keyHash, display: r.display, computers: r.computers, cardId: r.cardId, savedAt: r.savedAt, ...(r.bot === undefined ? {} : { bot: r.bot }) })) };
      const tmp = join(dir, `.saved-rules.${randomBytes(6).toString("hex")}.tmp`);
      const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600);
      try {
        writeSync(fd, `${JSON.stringify(doc, null, 2)}\n`);
      } finally {
        closeSync(fd);
      }
      try {
        if (process.platform !== "win32") chmodSync(tmp, 0o600);
        renameSync(tmp, path);
      } catch (err) {
        try { unlinkSync(tmp); } catch { /* best effort */ }
        throw err;
      }
    },
  };
}
