// Pins the Fence contract through FakeFence: what is fenced on each OS, how operations are judged, agents' roots, and
// the policy a sandbox enforces.
import { describe, expect, test } from "bun:test";
import { FakeFence } from "../fakes/fence";
import { CLOUD_METADATA_ADDRESSES, FENCED_KINDS, judge, type FencedKind } from "../fence";

const HOME = "/Users/me";
const CLOVER = `${HOME}/.clover`;
const fence = (os: "macos" | "linux" | "windows" = "macos", devFolders: string[] = []) =>
  new FakeFence({ os, home: HOME, cloverHome: CLOVER, temp: "/tmp", devFolders });

describe("FakeFence", () => {
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
    expect(mac.denyRead).toEqual([`${CLOVER}/run`]);
    expect(mac.closedDoors).toEqual(["open", "launchctl", "osascript"]);
    expect(mac.blockedAddresses).toEqual([...CLOUD_METADATA_ADDRESSES]);
    expect(mac.network).toBe("none");
    expect(fence("linux").policy().closedDoors).toEqual(["systemd-run"]);
    expect(fence("linux").policy().denyRead).toContain(`${CLOVER}/secrets.enc`);
    expect(fence("windows").policy().closedDoors).toContain("schtasks");
  });

  test("judge is the shared rule, usable over any set", () => {
    const set = [{ kind: "settings" as const, path: "/c/settings", deny: "write" as const }];
    expect(judge(set, { op: "write", path: "/c/settings/a" }).allowed).toBe(false);
    expect(judge(set, { op: "read", path: "/c/settings/a" }).allowed).toBe(true);
  });
});
