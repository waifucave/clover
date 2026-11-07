// The Fence conformance suite (review S15). `runFenceConformance(make)` registers every case against the
// implementation `make` builds; `tests/fence.test.ts` runs it against FakeFence, and the lane that writes the real
// one runs it there through a harness with the same drivers. What it pins:
// what is fenced on each OS, how operations are judged, agents' roots, and
// the policy a sandbox enforces.
import { describe, expect, test } from "bun:test";
import { type FakeFence } from "../fakes/fence";
import { CLOUD_METADATA_ADDRESSES, FENCED_KINDS, foldName, foldPath, judge, windowsAlias, type FencedKind } from "../fence";

/** What the suite drives: the contract and the fake's own drivers (what a test does to the world around it),
 *  as public members, so a real implementation's harness can provide them. */
export type FenceHarness = Pick<FakeFence, keyof FakeFence>;
/** Builds the implementation under test from the options the fake takes. */
export type FenceFactory = (...args: ConstructorParameters<typeof FakeFence>) => FenceHarness;

/** Cases an implementation can run as todo: `real-paths`, an agent root judged by its real path through a real
 *  symlink (the fake compares strings; lane C's real fence must pass it). */
export type FencePendingCase = "real-paths";

/** A real folder and real symlinks, for the `real-paths` case (the suites import no file system of their own). */
export interface FenceDisk {
  /** A new empty folder, by its real path. */
  folder(): string;
  /** A new symlink to `target`, by its path. */
  link(target: string): string;
}

export function runFenceConformance(make: FenceFactory, opts: { pending?: readonly FencePendingCase[]; disk?: FenceDisk } = {}): void {
  const pendingOr = (key: FencePendingCase) => (opts.pending?.includes(key) || !opts.disk ? test.todo : test);
  const HOME = "/Users/me";
  const CLOVER = `${HOME}/.clover`;
  const AGENT = "/opt/homebrew/lib/node_modules/@zed-industries/codex-acp";
  const fence = (os: "macos" | "linux" | "windows" = "macos", devFolders: string[] = []) =>
    make({ os, home: HOME, cloverHome: CLOVER, temp: "/tmp", devFolders, agentInstalls: [AGENT], bots: ["alpha"] });

  describe("Fence", () => {
    test("macOS fences every item but the secrets file and key files, which the Keychain holds", () => {
      const kinds = new Set(fence("macos", [`${HOME}/dev/luna`]).fencedSet().map((i) => i.kind));
      const expected = FENCED_KINDS.filter((k) => k !== "secrets-file" && k !== "key-file");
      expect([...kinds].sort()).toEqual([...expected].sort());
    });

    test("Windows and Linux also hide the secrets file and key files from reads", () => {
      for (const os of ["linux", "windows"] as const) {
        const f = fence(os);
        const secrets = f.fencedSet().find((i) => i.kind === "secrets-file")!;
        expect(secrets.deny).toBe("read-write");
        expect(f.check({ op: "read", path: secrets.path })).toEqual({ allowed: false, reason: "secrets-file", path: secrets.path });
      }
    });

    test("a write inside any fenced item is refused, with its kind", () => {
      const f = fence("linux", [`${HOME}/dev/luna`]);
      for (const item of f.fencedSet()) {
        if (item.deny === "caller") continue; // the caller's: below
        const verdict = f.check({ op: "write", path: `${item.path}/x` });
        expect(verdict).toEqual({ allowed: false, reason: item.kind as FencedKind, path: item.path });
      }
    });

    test("an agent's root is never inside the Clover home, nor inside or holding a fenced item (#197's check 3)", () => {
      for (const os of ["macos", "windows", "linux"] as const) {
        const f = fence(os);
        for (const root of [`${CLOVER}/plugins/tarot`, `${CLOVER}/plugins`, `${CLOVER}/settings`, `${CLOVER}/plugin-data`]) {
          expect([os, root, f.checkAgentRoot(root).allowed]).toEqual([os, root, false]);
        }
        expect(f.checkAgentRoot(`${HOME}/projects/site`)).toEqual({ allowed: true });
      }
      const f = fence("macos");
      expect(f.checkAgentRoot(AGENT)).toMatchObject({ allowed: false, reason: "agent-installs" });
      expect(f.checkAgentRoot(`${HOME}/Library/LaunchAgents`)).toMatchObject({ allowed: false, reason: "login-start" });
      expect(f.checkAgentRoot(`${HOME}/Library`).allowed).toBe(false); // it holds fenced items
    });

    test("bot-memory: only the owning bot's own sessions read and write its memory, listed bot or not (the owner's decision; #197's check 4)", () => {
      const f = make({ os: "macos", home: HOME, cloverHome: CLOVER, temp: "/tmp", bots: ["luna", "alpha", "pack/tarot"] });
      const mem = (bot: string) => `${CLOVER}/bots/${bot}/memory`;
      expect(f.fencedSet().filter((i) => i.kind === "bot-memory")).toEqual([
        { kind: "bot-memory", path: mem("luna"), deny: "caller", bot: "luna" },
        { kind: "bot-memory", path: mem("alpha"), deny: "caller", bot: "alpha" },
        { kind: "bot-memory", path: mem("pack--tarot"), deny: "caller", bot: "pack/tarot" },
      ]);
      const reach = (caller: Parameters<typeof f.forCaller>[0] | undefined, path: string) => {
        const c = caller === undefined ? { check: (op: Parameters<typeof f.check>[0]) => f.check(op) } : f.forCaller(caller);
        return [c.check({ op: "read", path }).allowed, c.check({ op: "write", path }).allowed];
      };
      const session = (bot: string | undefined, sessionKind: "bot" | "side-thread" | "agent" | "coding") =>
        ({ kind: "session", sessionId: `s_${sessionKind}`, sessionKind, ...(bot ? { bot } : {}) }) as const;
      const main = session("luna", "bot");
      expect(reach(main, `${mem("luna")}/MEMORY.md`)).toEqual([true, true]);
      expect(reach(session("luna", "side-thread"), `${mem("luna")}/MEMORY.md`)).toEqual([true, true]);
      expect(reach(main, `${mem("alpha")}/MEMORY.md`)).toEqual([false, false]);
      expect(reach(session("luna", "agent"), `${mem("luna")}/MEMORY.md`)).toEqual([false, false]); // its own agents too
      expect(reach(session(undefined, "coding"), `${mem("luna")}/MEMORY.md`)).toEqual([false, false]);
      expect(reach({ kind: "plugin", pluginId: "tarot" }, `${mem("luna")}/MEMORY.md`)).toEqual([false, false]);
      expect(reach({ kind: "peer", device: "desk0000000000000001", sessionId: "s_r", bot: "luna" }, `${mem("luna")}/MEMORY.md`)).toEqual([false, false]);
      expect(reach(undefined, `${mem("luna")}/MEMORY.md`)).toEqual([false, false]);
      expect(reach(session("pack/tarot", "bot"), `${mem("pack--tarot")}/MEMORY.md`)).toEqual([true, true]);
      // A bot the fence doesn't list (not made yet, synced before the list catches up, or removed): the same rule, so
      // a coding session can't seed a future bot's memory.
      expect(reach(session(undefined, "coding"), `${mem("newbot")}/MEMORY.md`)).toEqual([false, false]);
      expect(reach(undefined, `${mem("newbot")}/n.md`)).toEqual([false, false]);
      expect(reach(session("newbot", "bot"), `${mem("newbot")}/n.md`)).toEqual([true, true]);
      // Spellings: case, folding and `..` reach the same folder.
      expect(reach(main, `${CLOVER}/bots/ALPHA/Memory/n.md`)).toEqual([false, false]);
      expect(reach(main, `${CLOVER}/bots/luna/../alpha/memory/n.md`)).toEqual([false, false]);
      expect(reach(main, `${CLOVER}/bots/LUNA/MEMORY/n.md`)).toEqual([true, true]);
      // bots/ and bots/<x> hold memory: never deleted, moved or written over; the memory folder itself neither.
      for (const op of [{ op: "delete", path: `${CLOVER}/bots/luna` }, { op: "move", path: `${CLOVER}/bots/luna`, to: `${CLOVER}/bots/x` }, { op: "delete", path: `${CLOVER}/bots` }, { op: "delete", path: mem("luna") }, { op: "write", path: `${CLOVER}/bots/newbot` }] as const) {
        expect([op, f.forCaller(main).check(op).allowed]).toEqual([op, false]);
      }
      expect(f.forCaller(main).check({ op: "move", path: `${mem("luna")}/a.md`, to: `${mem("alpha")}/a.md` }).allowed).toBe(false);
      // The rest of a bot's folder isn't memory.
      expect(f.forCaller(session("luna", "agent")).check({ op: "write", path: `${CLOVER}/bots/luna/agents/a_1.jsonl` }).allowed).toBe(true);
      // Runners (J's ruling): every runner is denied every bot's memory, known or not; the owning bot's main
      // conversation and side threads get their own back (`ownMemory`), and no other bot's.
      for (const c of [main, session("luna", "side-thread"), session(undefined, "coding"), session("luna", "agent"), { kind: "plugin", pluginId: "tarot" } as const]) {
        const p = f.forCaller(c).policy();
        expect(p.denyRead).toContain(`${CLOVER}/bots/*/memory`);
        expect(p.denyWrite).toContain(`${CLOVER}/bots/*/memory`);
      }
      expect(f.forCaller(main).policy().ownMemory).toBe(mem("luna"));
      expect(f.forCaller(session("luna", "side-thread")).policy().ownMemory).toBe(mem("luna"));
      expect(f.forCaller(session("pack/tarot", "bot")).policy().ownMemory).toBe(mem("pack--tarot"));
      // A coding session's runner, and the bot's own agents', reach neither its memory nor any other.
      expect(f.forCaller(session(undefined, "coding")).policy().ownMemory).toBeUndefined();
      expect(f.forCaller(session("luna", "agent")).policy().ownMemory).toBeUndefined();
      expect(f.forCaller({ kind: "plugin", pluginId: "tarot" }).policy().ownMemory).toBeUndefined();
      expect(f.touches([`${mem("newbot")}/a`])).toMatchObject({ kind: "bot-memory", path: mem("newbot") });
      expect(f.forCaller(main).context).toEqual({ sessionId: "s_bot", memoryOf: "luna" });
    });

    pendingOr("real-paths")("an agent root is judged by its real path: a symlink to the home, or into the Clover home, is refused (#197's check 4)", () => {
      const disk = opts.disk!;
      const home = disk.folder();
      const f = make({ os: "macos", home, cloverHome: `${home}/.clover`, temp: "/tmp" });
      expect(f.checkAgentRoot(disk.link(home)).allowed).toBe(false);
      const intoClover = disk.link(`${home}/.clover`);
      // A root that doesn't exist yet is judged by its nearest existing ancestor's real path.
      expect(f.checkAgentRoot(`${intoClover}/plugins/new-plugin`).allowed).toBe(false);
      expect(f.checkAgentRoot(`${disk.link(disk.folder())}/project`).allowed).toBe(true);
    });

    test("sessions-runtime: write-denied; a session reads only its own state (#197's check 4)", () => {
      const f = fence("macos");
      const RT = `${CLOVER}/sessions-runtime`;
      const own = { kind: "session", sessionId: "s_1", sessionKind: "bot", bot: "luna" } as const;
      const other = { kind: "session", sessionId: "s_2", sessionKind: "coding" } as const;
      expect(f.check({ op: "write", path: `${RT}/s_1.json` })).toEqual({ allowed: false, reason: "sessions-runtime", path: RT });
      expect(f.forCaller(own).check({ op: "write", path: `${RT}/s_1.json` }).allowed).toBe(false);
      expect(f.forCaller(own).check({ op: "read", path: `${RT}/s_1.json` }).allowed).toBe(true);
      expect(f.forCaller(own).check({ op: "read", path: `${RT}/s_1/state.json` }).allowed).toBe(true);
      expect(f.forCaller(other).check({ op: "read", path: `${RT}/s_1.json` })).toEqual({ allowed: false, reason: "sessions-runtime", path: RT });
      expect(f.check({ op: "read", path: `${RT}/s_1.json` }).allowed).toBe(false);
      expect(f.forCaller({ kind: "user", client: "app" }).check({ op: "read", path: `${RT}/s_1.json` }).allowed).toBe(true);
      expect(f.policy().denyRead).toContain(RT);
    });

    test("reads are free except in the run folder (and the secrets files off macOS)", () => {
      const f = fence();
      expect(f.check({ op: "read", path: `${CLOVER}/settings/settings.json` })).toEqual({ allowed: true });
      expect(f.check({ op: "read", path: `${CLOVER}/run/core.sock` }).allowed).toBe(false);
      expect(f.check({ op: "list", path: CLOVER })).toEqual({ allowed: true });
    });

    test("the registry's own records are fenced: its OKs, the installed list and the 18+ confirmation (review S8)", () => {
      const f = fence();
      for (const kind of ["plugin-oks", "installed-plugins", "adult-confirmation"] as const) {
        const item = f.fencedSet().find((i) => i.kind === kind)!;
        expect(item.deny).toBe("write");
        expect(f.check({ op: "write", path: item.path })).toEqual({ allowed: false, reason: kind, path: item.path });
      }
    });

    test("routine files are not fenced; the installed plugins folder is (#197's check 2): bots get plugins in by the OK card", () => {
      const f = fence();
      expect(f.check({ op: "write", path: `${CLOVER}/plugins/luna/clover.json` })).toEqual({ allowed: false, reason: "plugins", path: `${CLOVER}/plugins` });
      expect(f.check({ op: "write", path: `${CLOVER}/routines/alpha/morning.md` })).toEqual({ allowed: true });
      expect(f.check({ op: "write", path: `${HOME}/project/README.md` })).toEqual({ allowed: true });
    });

    test("deleting or moving a folder that holds a fenced item is refused (renaming an ancestor moves it)", () => {
      const f = fence();
      expect(f.check({ op: "delete", path: CLOVER }).allowed).toBe(false);
      expect(f.check({ op: "move", path: CLOVER, to: "/tmp/stolen" }).allowed).toBe(false);
      expect(f.check({ op: "move", path: `${HOME}/a`, to: `${CLOVER}/settings/a` }).allowed).toBe(false);
      expect(f.check({ op: "delete", path: `${CLOVER}/plugins/old` }).allowed).toBe(false);
      expect(f.check({ op: "delete", path: `${CLOVER}/routines/old` }).allowed).toBe(true);
    });

    test("development folders are fenced while on, and changes reach watchers", () => {
      const f = fence();
      let changes = 0;
      f.watch(() => changes++);
      expect(f.check({ op: "write", path: `${HOME}/dev/luna/host/index.ts` }).allowed).toBe(true);
      f.addDevFolder(`${HOME}/dev/luna`);
      expect(f.check({ op: "write", path: `${HOME}/dev/luna/host/index.ts` })).toEqual({ allowed: false, reason: "dev-folders", path: `${HOME}/dev/luna` });
      f.removeDevFolder(`${HOME}/dev/luna`);
      expect(f.check({ op: "write", path: `${HOME}/dev/luna/host/index.ts` }).allowed).toBe(true);
      expect(changes).toBe(2);
    });

    test("touches finds a fenced item reached by any path, for the always-a-card rule", () => {
      const f = fence();
      expect(f.touches([`${HOME}/project/a.ts`])).toBeNull();
      expect(f.touches([`${HOME}/project/a.ts`, `${CLOVER}/levels/x.json`])?.kind).toBe("levels");
      expect(f.touches([HOME])?.kind).toBeDefined();
    });

    test("an agent's root may not hold the Clover home or a development folder", () => {
      const f = fence("macos", [`${HOME}/dev/luna`]);
      expect(f.checkAgentRoot(`${HOME}/project`)).toEqual({ allowed: true });
      expect(f.checkAgentRoot(HOME)).toEqual({ allowed: false, reason: "clover-home", path: CLOVER });
      expect(f.checkAgentRoot("/")).toEqual({ allowed: false, reason: "clover-home", path: CLOVER });
      expect(f.checkAgentRoot(`${HOME}/dev`)).toEqual({ allowed: false, reason: "dev-folders", path: `${HOME}/dev/luna` });
      expect(f.checkAgentRoot(`${HOME}/dev/luna`).allowed).toBe(false);
    });

    test("the policy: write in home and temp, less the fenced set; no network; the OS's closed doors; metadata blocked", () => {
      const mac = fence("macos").policy();
      expect(mac.allowWrite).toEqual([HOME, "/tmp"]);
      expect(mac.denyWrite).toContain(`${CLOVER}/credentials`);
      // The read-denied list includes the run folder; an implementation may hide more (lane C keeps `runtimes/`).
      expect(mac.denyRead).toContain(`${CLOVER}/run`);
      expect(mac.denyRead).toContain(`${HOME}/Library/Application Support/Clover/Partitions`);
      expect(mac.denyWrite).toEqual(expect.arrayContaining([`${CLOVER}/sessions`, `${CLOVER}/usage`, `${HOME}/Library/LaunchAgents/com.waifucave.clover.core.plist`]));
      // The installed plugins folder is write-denied, not read-denied (#197's check 2).
      expect(fence("macos").check({ op: "write", path: `${CLOVER}/plugins/tarot/clover.json` })).toEqual({ allowed: false, reason: "plugins", path: `${CLOVER}/plugins` });
      expect(fence("macos").check({ op: "read", path: `${CLOVER}/plugins/tarot/clover.json` }).allowed).toBe(true);
      // An OK'd coding agent's install folder is write-denied, not read-denied (lane K).
      expect(mac.denyWrite).toContain(AGENT);
      expect(mac.denyRead).not.toContain(AGENT);
      expect(fence("macos").check({ op: "write", path: `${AGENT}/dist/index.js` })).toEqual({ allowed: false, reason: "agent-installs", path: AGENT });
      expect(fence("macos").check({ op: "read", path: `${AGENT}/dist/index.js` }).allowed).toBe(true);
      expect(mac.closedDoors).toEqual(["open", "launchctl", "osascript"]);
      expect(mac.blockedAddresses).toEqual([...CLOUD_METADATA_ADDRESSES]);
      expect(mac.network).toBe("none");
      expect(fence("linux").policy().closedDoors).toEqual(["systemd-run"]);
      expect(fence("linux").policy().denyRead).toContain(`${CLOVER}/secrets.enc`);
      expect(fence("windows").policy().closedDoors).toContain("schtasks");
    });

    test("the browser's partitions are fenced under the app's sessionData, not userData (lane E's follow-up)", () => {
      // The app sets sessionData apart from userData; Electron's own default (and the fence's fallback) is userData.
      const session = `${HOME}/Library/Application Support/Clover/session`;
      const f = make({ os: "macos", home: HOME, cloverHome: CLOVER, temp: "/tmp", devFolders: [], sessionData: session });
      const paths = f.fencedSet().filter((i) => i.kind === "browser-profiles").map((i) => i.path);
      expect(paths).toEqual([`${session}/Partitions`]);
      expect(f.check({ op: "read", path: `${session}/Partitions/persist:user` })).toEqual({ allowed: false, reason: "browser-profiles", path: `${session}/Partitions` });
      expect(f.check({ op: "write", path: `${session}/Partitions/persist:user` }).allowed).toBe(false);
      // Without a sessionData the fence falls back to userData, as Electron itself does.
      const d = make({ os: "macos", home: HOME, cloverHome: CLOVER, temp: "/tmp", devFolders: [] });
      expect(d.fencedSet().filter((i) => i.kind === "browser-profiles").map((i) => i.path)).toEqual([`${HOME}/Library/Application Support/Clover/Partitions`]);
    });

    test("a fenced name in another case, not on disk yet, is refused on every OS (J-M1's review, B1)", () => {
      for (const os of ["macos", "windows", "linux"] as const) {
        const f = fence(os);
        for (const path of [`${CLOVER}/RULES/allow.json`, `${CLOVER}/Settings/settings.json`, `${CLOVER}/LEVELS/computer.json`, `${HOME}/.Clover/trust/x.json`]) {
          expect([os, path, f.check({ op: "write", path }).allowed]).toEqual([os, path, false]);
        }
        expect(f.check({ op: "move", path: `${HOME}/a.json`, to: `${CLOVER}/CONNECTORS/a.json` }).allowed).toBe(false);
        expect(f.touches([`${CLOVER}/Rules`])).not.toBeNull();
        expect(f.checkAgentRoot(`${HOME}/.CLOVER`).allowed).toBe(false);
      }
    });

    test("names a disk folds beyond lower case are refused: the long s, the Kelvin sign, ß (#179's review, F1)", () => {
      for (const os of ["macos", "windows", "linux"] as const) {
        const f = fence(os);
        // ſ (U+017F) upper-cases to S; the Kelvin sign (U+212A) is K; both open the fenced folder on APFS and NTFS.
        expect(f.check({ op: "write", path: `${CLOVER}/\u017Fettings/settings.json` })).toEqual({ allowed: false, reason: "settings", path: `${CLOVER}/settings` });
        expect(f.check({ op: "write", path: `${CLOVER}/rule\u017F/allow.json` })).toMatchObject({ allowed: false, reason: "saved-rules" });
        expect(f.check({ op: "write", path: `${CLOVER}/tru\u017Ft/x.json` })).toMatchObject({ allowed: false, reason: "trust" });
        expect(f.check({ op: "write", path: `${CLOVER}/plugins-state/o\u212As/x.json` })).toMatchObject({ allowed: false, reason: "plugin-oks" });
        expect(f.check({ op: "move", path: `${HOME}/a`, to: `${CLOVER}/\u212Aeys` })).toMatchObject({ allowed: false, reason: "clover-home" });
        expect(f.touches([`${CLOVER}/\u017Fettings`])).toMatchObject({ kind: "settings" });
        // ß folds to ss, and a name that isn't ASCII where Clover names things is refused whatever it folds to.
        expect(f.check({ op: "write", path: `${CLOVER}/\u00DFettings/x.json` })).toEqual({ allowed: false, reason: "clover-home", path: CLOVER });
        expect(f.check({ op: "write", path: `${CLOVER}/plugins-state/\u00F6ks/x.json` })).toMatchObject({ allowed: false, reason: "clover-home" });
        expect(f.check({ op: "read", path: `${CLOVER}/\u0455ettings/settings.json` })).toMatchObject({ allowed: false, reason: "clover-home" });
        // Where Clover doesn't name things (a bot's notes, a routine's files), any name is the user's own.
        expect(f.check({ op: "write", path: `${CLOVER}/bots/luna/agents/\u65E5\u8A18.md` }).allowed).toBe(true);
        expect(f.check({ op: "write", path: `${CLOVER}/routines/alpha/caf\u00E9.md` }).allowed).toBe(true);
        expect(f.check({ op: "write", path: `${HOME}/\u017Fettings.json` }).allowed).toBe(true);
      }
      expect(foldName("Stra\u00DFe")).toBe("strasse");
      expect(foldName("\u212A")).toBe("k");
      expect(foldName("\u017F")).toBe("s");
      expect(foldName(".clover. ", "windows")).toBe(".clover");
      expect(foldPath("C:\\Users\\Me", "windows")).toBe("c:/users/me");
    });

    test("on Windows a stream or an 8.3 short name is refused wherever it is (J's rules, #179's review check 2)", () => {
      const win = fence("windows");
      for (const path of [`${CLOVER}/settings/settings.json::$DATA`, `${CLOVER}/settings/settings.json:x`, `${HOME}/CLOVER~1/settings/settings.json`, `${HOME}/notes~2.md`]) {
        expect([path, win.check({ op: "write", path })]).toEqual([path, { allowed: false, reason: "alias", path }]);
        expect(win.check({ op: "read", path }).allowed).toBe(false);
      }
      expect(win.check({ op: "move", path: `${HOME}/a.json`, to: `${HOME}/CLOVER~1/rules/a.json` })).toMatchObject({ reason: "alias" });
      expect(windowsAlias("C:/Users/me/a.json")).toBeUndefined();
      // Elsewhere a colon or a tilde is part of a name.
      expect(fence("linux").check({ op: "write", path: `${HOME}/notes~2.md` }).allowed).toBe(true);
      expect(fence("macos").check({ op: "write", path: `${HOME}/a:b.txt` }).allowed).toBe(true);
    });

    test("judge is the shared rule, usable over any set", () => {
      const set = [{ kind: "settings" as const, path: "/c/settings", deny: "write" as const }];
      expect(judge(set, { op: "write", path: "/c/settings/a" }).allowed).toBe(false);
      expect(judge(set, { op: "read", path: "/c/settings/a" }).allowed).toBe(true);
    });
  });
}
