// Small files the core rewrites whole (a session's meta, a bot's user layer and state): written to a temporary file
// beside the target, flushed, then renamed over it, so a crash leaves either the old file or the new one, never half
// of one. Owner: lane D.
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const fd = openSync(tmp, "w");
  try {
    let written = 0;
    while (written < data.length) written += writeSync(fd, data, written, data.length - written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** The file's JSON, or `undefined` when it doesn't exist or doesn't parse. */
export function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}
