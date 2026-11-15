// P5 (the owner, 2026-11-15: "Yes, named on the card"): `host.outside` names programs of the user's run outside the
// plugin sandbox and folders of the user's read; the validator holds each to its form, a top-level plugin with a process
// of its own, and the OK card names every one with its warning.
import { expect, test } from "bun:test";
import { API_CALLS, describeOk, outsideFolderOk, outsideOkLines, outsideProgramOk, validateManifest } from "../src/index";

const manifest = (host: Record<string, unknown>) => ({ manifest: 1, id: "reader", name: "Reader", engines: { clover: "^1.0.0" }, host: { entry: "host/index.ts", ...host } });
const codes = (host: Record<string, unknown>, opts: Parameters<typeof validateManifest>[1] = { folderName: "reader" }) => validateManifest(manifest(host), opts).issues.filter((i) => i.severity === "error").map((i) => i.code);

test("a program is a name on the PATH or an absolute path; a folder is ~/… or an absolute path, never the whole home or disk", () => {
  for (const p of ["codex", "claude", "git", "python3.12", "/usr/local/bin/docker", "/Applications/Some App.app/Contents/MacOS/tool"]) expect([p, outsideProgramOk(p)]).toEqual([p, true]);
  for (const p of ["", "a b", "../x", "/usr/../bin/sh", "/", "./run", "-x", "/opt/bin/"]) expect([p, outsideProgramOk(p)]).toEqual([p, false]);
  for (const p of ["~/.codex", "~/.claude", "~/Library/Application Support/Thing", "/Volumes/Data/notes"]) expect([p, outsideFolderOk(p)]).toEqual([p, true]);
  for (const p of ["~", "~/", "/", "~/../x", "~/a/./b", "relative/path", "~user/x"]) expect([p, outsideFolderOk(p)]).toEqual([p, false]);
});

test("the validator: valid lists pass and are reported; a bad entry, a child, or no process of its own is refused", () => {
  const good = validateManifest(manifest({ process: "own", outside: { programs: ["codex", "/usr/bin/true"], read: ["~/.codex"] } }), { folderName: "reader" });
  expect(good.issues.filter((i) => i.severity === "error")).toEqual([]);
  expect(good.outside).toEqual({ programs: ["codex", "/usr/bin/true"], read: ["~/.codex"] });
  expect(codes({ process: "own", outside: { programs: ["a b"] } })).toEqual(["outside_program_invalid"]);
  expect(codes({ process: "own", outside: { read: ["~"] } })).toEqual(["outside_folder_invalid"]);
  expect(codes({ outside: { programs: ["codex"] } })).toEqual(["outside_own_process"]);
  const child = validateManifest({ manifest: 1, name: "Kid", engines: { clover: "^1.0.0" }, host: { entry: "host/index.ts", process: "own", outside: { programs: ["codex"] } } }, { parent: { id: "acme", namespace: "acme" }, folderName: "kid" });
  expect(child.issues.filter((i) => i.severity === "error").map((i) => i.code)).toContain("outside_top_only");
  expect(validateManifest(manifest({ process: "own" }), { folderName: "reader" }).outside).toEqual({ programs: [], read: [] });
});

test("the OK card names every program and folder with its warning; none when it names none", () => {
  const ok = describeOk(validateManifest(manifest({ process: "own", outside: { programs: ["codex", "claude"], read: ["~/.codex", "~/.claude"] } }), { folderName: "reader" }));
  expect(ok).toContain("It runs these programs of yours outside Clover's sandbox, with your own access (your sign-ins, your Keychain, your files and your network): codex, claude.");
  expect(ok).toContain("It reads these folders of yours outside its sandbox: ~/.codex, ~/.claude.");
  expect(outsideOkLines({ programs: ["git"], read: [] })).toEqual(["It runs this program of yours outside Clover's sandbox, with your own access (your sign-ins, your Keychain, your files and your network): git."]);
  expect(outsideOkLines({ programs: [], read: [] })).toEqual([]);
  expect(describeOk(validateManifest(manifest({ process: "own" }), { folderName: "reader" })).some((l) => l.includes("outside"))).toBe(false);
});

test("outside.run is a host half's call, granted by the manifest's list (no capability)", () => {
  expect(API_CALLS["outside.run"]).toEqual({ where: "host" });
});
