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

export function runFenceConformance(make: FenceFactory): void {
  const HOME = "/Users/me";
  const CLOVER = `${HOME}/.clover`;
  const AGENT = "/opt/homebrew/lib/node_modules/@zed-industries/codex-acp";
  const fence = (os: "macos" | "linux" | "windows" = "macos", devFolders: string[] = []) =>
    make({ os, home: HOME, cloverHome: CLOVER, temp: "/tmp", devFolders, agentInstalls: [AGENT] });

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
        const verdict = f.check({ op: "write", path: `${item.path}/x` });
        expect(verdict).toEqual({ allowed: false, reason: item.kind as FencedKind, path: item.path });
      }
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

    test("the plugins folder and routine files are not fenced: bots write plugins and routines as files", () => {
      const f = fence();
      expect(f.check({ op: "write", path: `${CLOVER}/plugins/luna/clover.json` })).toEqual({ allowed: true });
      expect(f.check({ op: "write", path: `${CLOVER}/routines/alpha/morning.md` })).toEqual({ allowed: true });
      expect(f.check({ op: "write", path: `${HOME}/project/README.md` })).toEqual({ allowed: true });
    });

    test("deleting or moving a folder that holds a fenced item is refused (renaming an ancestor moves it)", () => {
      const f = fence();
      expect(f.check({ op: "delete", path: CLOVER }).allowed).toBe(false);
      expect(f.check({ op: "move", path: CLOVER, to: "/tmp/stolen" }).allowed).toBe(false);
      expect(f.check({ op: "move", path: `${HOME}/a`, to: `${CLOVER}/settings/a` }).allowed).toBe(false);
      expect(f.check({ op: "delete", path: `${CLOVER}/plugins/old` }).allowed).toBe(true);
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
        // Where Clover doesn't name things (a bot's notes, a plugin's files), any name is the user's own.
        expect(f.check({ op: "write", path: `${CLOVER}/bots/luna/memory/\u65E5\u8A18.md` }).allowed).toBe(true);
        expect(f.check({ op: "write", path: `${CLOVER}/plugins/tarot/assets/caf\u00E9.png` }).allowed).toBe(true);
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
