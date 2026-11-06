// Small files the core rewrites whole (a session's meta, a bot's user layer and state): written to a temporary file
// beside the target, flushed to the drive, then renamed over it, and the folder flushed, so a crash or a power cut
// leaves either the old file or the new one, never half of one. Owner: lane D.
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { syncDir, syncFile } from "./durable-io";

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const fd = openSync(tmp, "wx");
  try {
    let written = 0;
    while (written < data.length) written += writeSync(fd, data, written, data.length - written);
    syncFile(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  syncDir(dirname(path));
}

/** Removes a file and flushes its folder, so the removal survives a power cut. */
export function removeFileDurably(path: string): void {
  if (!existsSync(path)) return;
  unlinkSync(path);
  syncDir(dirname(path));
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
