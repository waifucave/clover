// A coding session's or an agent's changes in its folder, for the diff panel (`session.diff`): the working tree against
// HEAD, per file with its hunks, untracked files as added. Read only: git runs with no optional locks (it never writes
// the index), no fsmonitor, no external diff and no textconv driver (none of the folder's own config runs a program),
// and a symlink is shown as its target's path, never followed. Bounded: at most DIFF_FILES_MAX files, DIFF_FILE_MAX_LINES
// lines and DIFF_FILE_MAX_BYTES of text a file, DIFF_TOTAL_MAX_BYTES in all; what a bound cuts is listed without its
// lines and said in the notice.
import { lstatSync, openSync, readSync, closeSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { SessionDiff, SessionDiffFile } from "@waifucave/clover-protocol";

export const DIFF_FILES_MAX = 300;
export const DIFF_FILE_MAX_LINES = 2_000;
export const DIFF_FILE_MAX_BYTES = 256 * 1024;
export const DIFF_TOTAL_MAX_BYTES = 2 * 1024 * 1024;
/** The most of git's patch output read; past it every file is listed without its lines. */
const PATCH_MAX_BYTES = 32 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;
/** git's empty tree: the base of a repository with no commits yet. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const TARGET = "working tree";

type Hunk = NonNullable<SessionDiffFile["hunks"]>[number];

/** One git command in `dir`: its output, or undefined when it failed (or ran too long, or said too much). */
async function git(dir: string, args: string[], maxBytes = 4 * 1024 * 1024): Promise<{ out: string; cut: boolean } | undefined> {
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "USER", "TMPDIR", "SYSTEMROOT"]) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.LC_ALL = "C";
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", ...args], { cwd: dir, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  } catch {
    return undefined;
  }
  const timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let cut = false;
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > maxBytes) {
        cut = true;
        proc.kill();
        break;
      }
      chunks.push(value);
      size += value.length;
    }
    const code = await proc.exited;
    if (!cut && code !== 0) return undefined;
    return { out: Buffer.concat(chunks).toString("utf8"), cut };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** `--numstat -z`: each file's counts (`-` for a binary one), and a rename's old path. */
function parseNumstat(out: string): { path: string; from?: string; added: number; removed: number; binary: boolean }[] {
  const parts = out.split("\0");
  const rows: { path: string; from?: string; added: number; removed: number; binary: boolean }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i]!;
    if (head === "") continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(head);
    if (!m) continue;
    const binary = m[1] === "-" || m[2] === "-";
    const counts = { added: binary ? 0 : Number(m[1]), removed: binary ? 0 : Number(m[2]), binary };
    if (m[3] === "") {
      // A rename: the old path and the new one follow as their own fields.
      const from = parts[++i] ?? "";
      const to = parts[++i] ?? "";
      rows.push({ path: to, from, ...counts });
    } else rows.push({ path: m[3]!, ...counts });
  }
  return rows;
}

/** The patch's sections, one per file in git's order: whether it's new, deleted or a rename, binary, and its hunks. */
function parsePatch(out: string): { status: SessionDiffFile["status"] | undefined; binary: boolean; hunks: Hunk[]; bytes: number; lines: number }[] {
  const sections: { status: SessionDiffFile["status"] | undefined; binary: boolean; hunks: Hunk[]; bytes: number; lines: number }[] = [];
  let cur: (typeof sections)[number] | undefined;
  let hunk: Hunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { status: undefined, binary: false, hunks: [], bytes: 0, lines: 0 };
      sections.push(cur);
      hunk = undefined;
      continue;
    }
    if (cur === undefined) continue;
    if (hunk === undefined) {
      if (line.startsWith("new file mode")) cur.status = "added";
      else if (line.startsWith("deleted file mode")) cur.status = "deleted";
      else if (line.startsWith("rename from ")) cur.status = "renamed";
      else if (line.startsWith("Binary files ") || line === "GIT binary patch") cur.binary = true;
    }
    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (at) {
      oldNo = Number(at[1]);
      newNo = Number(at[2]);
      hunk = { header: line.slice(0, 2_000), lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (hunk === undefined || line.startsWith("\\")) continue;
    const mark = line[0];
    const text = line.slice(1);
    if (mark === " ") hunk.lines.push({ kind: "context", old: oldNo++, new: newNo++, text });
    else if (mark === "+") hunk.lines.push({ kind: "add", new: newNo++, text });
    else if (mark === "-") hunk.lines.push({ kind: "del", old: oldNo++, text });
    else continue;
    cur.bytes += line.length + 1;
    cur.lines++;
  }
  return sections;
}

/** An untracked file, as added: its lines (a symlink: its target's path), or binary, or too large. */
function untrackedFile(dir: string, path: string): { file: SessionDiffFile; bytes: number } {
  const full = join(dir, path);
  let st;
  try {
    st = lstatSync(full);
  } catch {
    return { file: { path, status: "added", added: 0, removed: 0 }, bytes: 0 };
  }
  let text: string;
  if (st.isSymbolicLink()) {
    try { text = readlinkSync(full); } catch { text = ""; }
  } else if (!st.isFile()) {
    return { file: { path, status: "added", added: 0, removed: 0 }, bytes: 0 };
  } else if (st.size > DIFF_FILE_MAX_BYTES) {
    return { file: { path, status: "added", added: 0, removed: 0, tooLarge: true }, bytes: 0 };
  } else {
    const buf = Buffer.alloc(st.size);
    let fd: number | undefined;
    try {
      fd = openSync(full, "r");
      let read = 0;
      while (read < buf.length) {
        const n = readSync(fd, buf, read, buf.length - read, read);
        if (n <= 0) break;
        read += n;
      }
    } catch {
      return { file: { path, status: "added", added: 0, removed: 0 }, bytes: 0 };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    if (buf.subarray(0, 8_000).includes(0)) return { file: { path, status: "added", added: 0, removed: 0, binary: true }, bytes: 0 };
    text = buf.toString("utf8");
  }
  const lines = text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
  if (lines.length > DIFF_FILE_MAX_LINES) return { file: { path, status: "added", added: lines.length, removed: 0, tooLarge: true }, bytes: 0 };
  const hunks: Hunk[] = lines.length === 0 ? [] : [{ header: `@@ -0,0 +1,${lines.length} @@`, lines: lines.map((t, i) => ({ kind: "add" as const, new: i + 1, text: t })) }];
  return { file: { path, status: "added", added: lines.length, removed: 0, ...(hunks.length > 0 ? { hunks } : {}) }, bytes: text.length };
}

/** The changes in `dir`, a folder on this computer. */
export async function folderDiff(dir: string): Promise<SessionDiff> {
  const empty = (notice: string, base = ""): SessionDiff => ({ base, target: TARGET, targets: [], files: [], notice });
  const top = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (top === undefined) return empty("This folder isn't a git repository, so there are no changes to compare.");
  const head = await git(dir, ["rev-parse", "--verify", "-q", "HEAD"]);
  const base = head === undefined ? EMPTY_TREE : "HEAD";
  const label = head === undefined ? "no commits yet" : ((await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]))?.out.trim() || "HEAD");
  const diffArgs = ["diff", base, "-M", "--relative", "--no-ext-diff", "--no-textconv", "--no-color"];
  const numstat = await git(dir, [...diffArgs, "--numstat", "-z", "--", "."]);
  if (numstat === undefined) return empty("git couldn't read this folder's changes.", label);
  const rows = parseNumstat(numstat.out);
  const untracked = (await git(dir, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]))?.out.split("\0").filter((p) => p !== "") ?? [];
  const totalFiles = rows.length + untracked.length;
  const cuts: string[] = [];
  const patch = rows.length === 0 ? { out: "", cut: false } : await git(dir, [...diffArgs, "--unified=3", "--", "."], PATCH_MAX_BYTES);
  const sections = patch === undefined || patch.cut ? undefined : parsePatch(patch.out);
  if (rows.length > 0 && sections === undefined) cuts.push("the changes are too large to read whole, so no file's lines are shown");
  const files: SessionDiffFile[] = [];
  let total = 0;
  let pastTotal = 0;
  let pastFile = 0;
  for (const [i, row] of rows.entries()) {
    if (files.length >= DIFF_FILES_MAX) break;
    const sec = sections?.[i];
    const status: SessionDiffFile["status"] = row.from !== undefined && row.from !== row.path ? "renamed" : (sec?.status ?? "modified");
    const file: SessionDiffFile = { path: row.path, status, ...(row.from !== undefined && row.from !== row.path ? { from: row.from } : {}), added: row.added, removed: row.removed };
    if (row.binary || sec?.binary) file.binary = true;
    else if (sec !== undefined) {
      if (sec.lines > DIFF_FILE_MAX_LINES || sec.bytes > DIFF_FILE_MAX_BYTES) { file.tooLarge = true; pastFile++; }
      else if (total + sec.bytes > DIFF_TOTAL_MAX_BYTES) { file.tooLarge = true; pastTotal++; }
      else if (sec.hunks.length > 0) { file.hunks = sec.hunks; total += sec.bytes; }
    } else file.tooLarge = true;
    files.push(file);
  }
  for (const path of untracked) {
    if (files.length >= DIFF_FILES_MAX) break;
    const { file, bytes } = untrackedFile(dir, path);
    if (file.tooLarge) pastFile++;
    else if (file.hunks !== undefined && total + bytes > DIFF_TOTAL_MAX_BYTES) { delete file.hunks; file.tooLarge = true; pastTotal++; }
    else total += bytes;
    files.push(file);
  }
  if (totalFiles > files.length) cuts.push(`showing the first ${files.length} of ${totalFiles} changed files`);
  if (pastFile > 0) cuts.push(`${pastFile} ${pastFile === 1 ? "file is" : "files are"} too big to show here (over ${DIFF_FILE_MAX_LINES} lines or ${DIFF_FILE_MAX_BYTES / 1024} KB)`);
  if (pastTotal > 0) cuts.push(`${pastTotal} more ${pastTotal === 1 ? "file is" : "files are"} listed without lines (the changes shown reached ${DIFF_TOTAL_MAX_BYTES / (1024 * 1024)} MB)`);
  const notice = cuts.length === 0 ? undefined : `${cuts.join("; ")}.`.replace(/^./, (c) => c.toUpperCase());
  return { base: label, target: TARGET, targets: [], files, ...(notice === undefined ? {} : { notice }) };
}
