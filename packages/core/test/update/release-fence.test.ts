// The apps' records (`<home>/apps/`) and the engine's install (`<home>/bin/`, its lock `bin/.install.lock`) stay under the
// home's default-deny: no bot, coding agent or plugin writes them, however the path is spelled (`..`, case, a link planted
// in a folder they can write, a rename into place). Reading stays as the home's rule has it (a bot reads the home; a coding
// session doesn't). No new fence mechanism: this pins the one that holds.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/moss-protocol";
import { MossFence } from "../../src/fence/fence";

const root = realpathSync(mkdtempSync(join(tmpdir(), "moss-rl-fence-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const home = join(root, "home");
const moss = join(home, ".moss");
mkdirSync(join(moss, "apps"), { recursive: true });
mkdirSync(join(moss, "bin", "daemon"), { recursive: true });
mkdirSync(join(moss, "scratch", "luna"), { recursive: true });
mkdirSync(join(home, "project"), { recursive: true });
writeFileSync(join(moss, "apps", "code.json"), "{}");
const fence = new MossFence({ home, mossHome: moss, temp: join(root, "tmp") });
const callers: [string, Caller][] = [
  ["a bot", { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "luna" }],
  ["a bot's side thread", { kind: "session", sessionId: "t1", sessionKind: "side-thread", bot: "luna" }],
  ["a coding agent", { kind: "session", sessionId: "c1", sessionKind: "coding" }],
  ["a plugin", { kind: "plugin", pluginId: "tarot" }],
];

describe("the records and the install lock are not the runners' to write", () => {
  for (const [who, caller] of callers) {
    test(`${who}: writes, deletes and renames into apps/ and bin/ are refused`, () => {
      const f = fence.forCaller(caller);
      for (const path of [join(moss, "apps", "code.json"), join(moss, "apps", "moss.json"), join(moss, "apps", "host.json"), join(moss, "bin", ".install.lock"), join(moss, "bin", "daemon", "moss-core"), join(moss, "bin", "engine.json")]) {
        expect(f.check({ op: "write", path }).allowed).toBe(false);
      }
      expect(f.check({ op: "delete", path: join(moss, "apps", "code.json") }).allowed).toBe(false);
      // A rename into place from a folder the runner may write.
      expect(f.check({ op: "move", path: join(home, "project", "code.json"), to: join(moss, "apps", "code.json") }).allowed).toBe(false);
      expect(f.check({ op: "move", path: join(moss, "apps", "code.json"), to: join(home, "project", "code.json") }).allowed).toBe(false);
      // `..`, and the other spelling of the same folder.
      expect(f.check({ op: "write", path: join(home, "project", "..", ".moss", "apps", "code.json") }).allowed).toBe(false);
      expect(f.check({ op: "write", path: join(moss, "APPS", "Code.json") }).allowed).toBe(false);
      // A path that doesn't exist yet.
      expect(f.check({ op: "write", path: join(moss, "apps", "never-written.json") }).allowed).toBe(false);
    });
  }

  test("a link planted in a writable folder that leads to apps/ or the lock is followed, and refused", () => {
    mkdirSync(join(home, "project"), { recursive: true });
    symlinkSync(join(moss, "apps"), join(home, "project", "linked-apps"));
    symlinkSync(join(moss, "bin", ".install.lock"), join(home, "project", "linked-lock"));
    for (const [, caller] of callers) {
      const f = fence.forCaller(caller);
      expect(f.check({ op: "write", path: join(home, "project", "linked-apps", "code.json") }).allowed).toBe(false);
      expect(f.check({ op: "write", path: join(home, "project", "linked-lock") }).allowed).toBe(false);
    }
  });

  test("the app itself (the user) writes its record, which is who may", () => {
    expect(fence.forCaller({ kind: "user", client: "app" }).check({ op: "write", path: join(moss, "apps", "code.json") }).allowed).toBe(true);
  });
});
