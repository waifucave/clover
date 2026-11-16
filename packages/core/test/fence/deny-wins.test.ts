// The controller's ruling: inside any sandbox config, a DENY always wins over an ALLOW, whatever the order or how
// specific each is. A runner's own folders are carved out of the home default-deny (the denies that hold them),
// never an allow that re-opens a denied subpath. Pinned here with an allowed folder too wide on purpose (a runner's
// own folder set to the whole MOSS home): sessions/ stays write-denied, and the secrets and run/ read- and
// write-denied, inside it, in the reference (`policyAllows`), in the macOS profile (as text, and live under
// sandbox-exec) and in the Linux mounts. (Reading the bots' conversations is the owner's later ruling's, not this
// file's: sessions/ and transcripts/ are write-denied items here.)
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { policyAllows, type SandboxPolicy } from "../../src/contracts/fence";
import { MossFence } from "../../src/fence/fence";
import { bwrapPlan } from "../../src/fence/linux-bwrap";
import { macFenceProfile } from "../../src/fence/macos-profile";
import { callerPlaces } from "../../src/fence/per-caller";
import { darwinDescribe } from "../helpers/darwin-only";

const BOT = { sessionId: "s1", memoryOf: "luna" };

/** The real fence's policy for a bot's own conversation, with its scratch folder widened to the whole MOSS home. */
function widened(os: "linux" | "macos", home: string, moss: string): SandboxPolicy {
  const policy = new MossFence({ os, home, mossHome: moss, temp: "/tmp", canonical: (p) => p }).policy(BOT);
  return { ...policy, ownScratch: moss };
}

describe("a deny always wins over an allow", () => {
  test("the reference: an own folder holding sessions/, the secrets and run/ never re-opens them", () => {
    const moss = "/home/me/.moss";
    const p = widened("linux", "/home/me", moss);
    for (const path of [`${moss}/sessions/s1.json`, `${moss}/transcripts/s1.jsonl`, `${moss}/run/core.sock`, `${moss}/secrets.enc`, `${moss}/secrets.key`]) {
      expect([path, policyAllows(p, "write", path, "linux")]).toEqual([path, false]);
    }
    for (const path of [`${moss}/run/core.sock`, `${moss}/secrets.enc`, `${moss}/secrets.key`]) {
      expect([path, policyAllows(p, "read", path, "linux")]).toEqual([path, false]);
    }
    // What the folder holds otherwise is carved out of the home deny: the runner's own.
    expect(policyAllows(p, "write", `${moss}/scratch/luna/notes.md`, "linux")).toBe(true);
    expect(policyAllows(p, "write", `${moss}/notes.md`, "linux")).toBe(true);
    // The real, narrow own folders as they are: the scratch writes, its neighbours don't.
    const narrow = new MossFence({ os: "linux", home: "/home/me", mossHome: moss, temp: "/tmp", canonical: (p) => p }).policy(BOT);
    expect(policyAllows(narrow, "write", `${moss}/scratch/luna/notes.md`, "linux")).toBe(true);
    expect(policyAllows(narrow, "write", `${moss}/scratch/other/notes.md`, "linux")).toBe(true); // any bot's scratch (the owner's ruling)
    const coding = new MossFence({ os: "linux", home: "/home/me", mossHome: moss, temp: "/tmp", canonical: (p) => p }).policy({ sessionId: "c1" });
    expect(policyAllows(coding, "write", `${moss}/scratch/other/notes.md`, "linux")).toBe(false);
    expect(policyAllows(narrow, "write", `${moss}/sessions/s1.json`, "linux")).toBe(false);
  });

  test("macOS's profile: the denies inside an own folder come again after its allows", () => {
    const moss = "/U/me/.moss";
    const policy = widened("macos", "/U/me", moss);
    const caller = { ...callerPlaces(moss, "macos", BOT), ownScratch: moss };
    const profile = macFenceProfile({ mossHome: moss, home: "/U/me", perUserTemp: null, caller, policy });
    const allowAt = profile.indexOf(`(allow file-read* file-write* (regex #"^${moss.replace(/\./g, "\\.")}/"))`);
    expect(allowAt).toBeGreaterThan(0);
    const after = profile.slice(allowAt);
    const denied = (op: "write" | "read", d: string) => new RegExp(`\\(deny file-${op}\\*[^\\n]*\\(subpath "${d.replace(/\./g, "\\.")}"\\)`);
    for (const d of [`${moss}/sessions`, `${moss}/transcripts`, `${moss}/run`]) expect(after).toMatch(denied("write", d));
    expect(after).toMatch(denied("read", `${moss}/run`));
  });

  test("Linux's mounts: a fenced item inside a bound own folder is masked again after the bind", () => {
    const moss = "/home/me/.moss";
    const policy = widened("linux", "/home/me", moss);
    const caller = { ...callerPlaces(moss, "linux", BOT), ownScratch: moss };
    const dirs = new Set(["/home/me", moss, `${moss}/sessions`, `${moss}/run`, `${moss}/transcripts`, `${moss}/scratch`, "/tmp"]);
    const files = new Set([`${moss}/secrets.enc`, `${moss}/secrets.key`]);
    const fs = { kind: (p: string) => (dirs.has(p) ? "dir" as const : files.has(p) ? "file" as const : null), list: () => [] };
    const { args } = bwrapPlan({ policy, mossHome: moss, cwd: "/home/me", uid: 1000, fs, caller });
    const bind = args.findIndex((a, i) => a === "--bind" && args[i + 1] === moss && args[i + 2] === moss);
    expect(bind).toBeGreaterThan(0);
    const after = args.slice(bind + 3).join(" ");
    for (const d of [`${moss}/sessions`, `${moss}/transcripts`]) expect(after).toContain(`--ro-bind ${d} ${d}`);
    expect(after).toContain(`--tmpfs ${moss}/run --remount-ro ${moss}/run`);
    for (const f of [`${moss}/secrets.enc`, `${moss}/secrets.key`]) expect(after).toContain(`--ro-bind /dev/null ${f}`);
  });
});

darwinDescribe("a deny always wins over an allow, live under sandbox-exec", () => {
  test("sessions/ and run/ inside an allowed folder can't be written, run/ can't be read; the rest of it can", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "lane-c-deny-wins-")));
    const moss = join(home, ".moss");
    for (const d of [join(moss, "sessions"), join(moss, "run")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(moss, "run", "token"), "secret");
    const policy = { ...new MossFence({ os: "macos", home, mossHome: moss, temp: join(home, "tmp") }).policy(BOT), ownScratch: moss };
    const caller = { ...callerPlaces(moss, "macos", BOT), ownScratch: moss };
    const profile = macFenceProfile({ mossHome: moss, home, perUserTemp: null, caller, policy });
    const sh = (script: string, ...args: string[]) => spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", script, "sh", ...args], { encoding: "utf8" });
    expect(sh('printf x > "$1"', join(moss, "sessions", "new.json")).status).not.toBe(0);
    expect(existsSync(join(moss, "sessions", "new.json"))).toBe(false);
    expect(sh('printf x > "$1"', join(moss, "run", "core.sock")).status).not.toBe(0);
    expect(sh('cat "$1"', join(moss, "run", "token")).stdout).not.toContain("secret");
    expect(sh('printf x > "$1"', join(moss, "notes.md")).status).toBe(0);
    expect(readFileSync(join(moss, "notes.md"), "utf8")).toBe("x");
  });
});
