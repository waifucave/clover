// The owner's try 14: every file tool of Alpha's came back "Error: protected host path access refused", a Write of a
// new file on his Desktop included, though macOS had let Clover into the Desktop. The runtime's file-tool check (agent
// SDK 0.0.78 `hostCodePathAllowed`) resolves every deny entry of the session at each call, inside one `try`, and
// refuses EVERY path when one entry fails to resolve with anything but "not there". The user's secret places in
// `~/Library` (Mail, Messages, Safari, Cookies, Safari's container) are folders macOS keeps Clover out of without Full
// Disk Access: Bun's `realpathSync` opens a path, and answers EPERM there. Here a folder without permission (mode 000)
// stands for one: `realpathSync` answers EACCES on it the same way, while `lstat` still works.
//
// Checked with the installed runtime's own check, not a copy: the sandbox Clover hands the runtime (`botSandbox`,
// `runtimeDenyForms`) lets the file tools work everywhere else, and still refuses the secret place, a file under it, the
// place in another letter case, and a link elsewhere into it. A Finder `.DS_Store` among the bots' scratch folders
// (a name under a file never resolves: ENOTDIR) breaks nothing either.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { secretReadPlaces } from "../../src/contracts/fence";
import { CloverFence } from "../../src/fence/fence";
import { runtimeDenyForms } from "../../src/fence/runtime-deny-forms";
import { botSandboxSettings, KEPT_FOLDER_PIN } from "../../src/fence/sandbox-settings";
import { botSandbox } from "../../src/runtime-sdk/turn-loop/driver";
import { darwinDescribe } from "../helpers/darwin-only";

type Allowed = (path: string, access: "read" | "write", settings?: { filesystem?: { denyRead?: string[]; denyWrite?: string[] } }, cwd?: string) => boolean;

/** The installed runtime's own `hostCodePathAllowed`: its package doesn't export it by name, its bundle chunk does. */
async function runtimeCheck(): Promise<Allowed> {
  const dist = dirname(Bun.resolveSync("@waifucave/clover-agent-runtime", import.meta.dir));
  for (const f of readdirSync(dist)) {
    if (!f.endsWith(".js") || !readFileSync(join(dist, f), "utf8").includes("function hostCodePathAllowed(")) continue;
    const mod = await import(join(dist, f)) as { hostCodePathAllowed?: Allowed };
    if (typeof mod.hostCodePathAllowed === "function") return mod.hostCodePathAllowed;
  }
  throw new Error("the installed runtime has no hostCodePathAllowed");
}

const temps: { dir: string; locked: string[] }[] = [];
afterAll(() => {
  for (const t of temps.splice(0)) {
    for (const l of t.locked) { try { chmodSync(l, 0o700); } catch { /* gone */ } }
    rmSync(t.dir, { recursive: true, force: true });
  }
});

/** A user's home shaped like a Mac's, with `~/Library/Mail` and `~/Library/Containers` closed to this process, and its
 *  Clover home with Alpha's folders and a `.DS_Store` among the bots' scratch folders. */
function mac() {
  const user = realpathSync(mkdtempSync(join(tmpdir(), "deny-forms-home-")));
  const t = { dir: user, locked: [] as string[] };
  temps.push(t);
  for (const d of ["Desktop", "Documents", "Library/Mail/V10", "Library/Containers/com.apple.Safari/Data", "Library/Application Support", ".ssh"]) mkdirSync(join(user, d), { recursive: true });
  writeFileSync(join(user, "Library/Mail/V10/inbox.mbox"), "secret");
  writeFileSync(join(user, "Documents", "notes.md"), "once");
  const clover = join(user, ".clover");
  for (const d of ["scratch/alpha", "bots/alpha/memory", "outputs/s1", "routines/alpha"]) mkdirSync(join(clover, d), { recursive: true });
  writeFileSync(join(clover, "scratch", ".DS_Store"), "finder");
  writeFileSync(join(clover, "bots", ".DS_Store"), "finder");
  const lock = (rel: string) => { chmodSync(join(user, rel), 0o000); t.locked.push(join(user, rel)); };
  return { user, clover, lock };
}

/** Alpha's sandbox at the default level as the driver hands it to the runtime. */
function alphaSandbox(user: string, clover: string, forms = true) {
  const policy = new CloverFence({ os: "macos", home: user, cloverHome: clover, temp: "/private/tmp", canonical: (p) => p })
    .policy({ sessionId: "s1", memoryOf: "alpha" } as never);
  const drawn = botSandboxSettings(policy, { cloverHome: clover, userHome: user, level: undefined, ownFolders: [join(clover, "scratch", "alpha")], pathFolders: [] });
  return forms ? botSandbox(drawn, { userHome: user, os: "macos" }) : drawn;
}

darwinDescribe("deny lists the runtime's file-tool check can resolve", () => {
  test("a secret place Clover is kept out of no longer refuses every path; it, a file under it, its other cases and a link into it stay refused", async () => {
    const allowed = await runtimeCheck();
    const { user, clover, lock } = mac();
    const link = join(user, "Desktop", "mail-link");
    symlinkSync(join(user, "Library/Mail/V10"), link);
    lock("Library/Mail");
    lock("Library/Containers");
    // As before: the plain entries make the check refuse a Write on the Desktop (the owner's report).
    const before = alphaSandbox(user, clover, false);
    expect(allowed(join(user, "Desktop", "hello_world.md"), "write", before as never)).toBe(false);
    const s = alphaSandbox(user, clover) as never;
    for (const [path, access] of [
      [join(user, "Desktop", "hello_world.md"), "write"], [join(user, "Desktop", "hello_world.md"), "read"],
      [join(user, "Documents", "notes.md"), "read"], [join(user, "Documents", "notes.md"), "write"],
      [join(clover, "scratch", "alpha", "draft.md"), "write"], [join(clover, "bots", "alpha", "memory", "m.md"), "write"],
      [user, "read"], [join(user, "Library", "Application Support"), "read"],
    ] as const) expect([path, access, allowed(path, access, s)]).toEqual([path, access, true]);
    for (const [path, access] of [
      [join(user, "Library/Mail"), "read"], [join(user, "Library/Mail/V10/inbox.mbox"), "read"], [join(user, "Library/Mail/new.md"), "write"],
      [join(user, "library/MAIL/V10/inbox.mbox"), "read"], [join(user, "LIBRARY/mail"), "write"],
      [join(link, "inbox.mbox"), "read"], [link, "read"],
      [join(user, "Library/Containers/com.apple.Safari"), "read"], [join(user, "Library/Containers/com.apple.Safari/Data/x"), "write"],
      [join(user, ".ssh", "id_ed25519"), "read"],
    ] as const) expect([path, access, allowed(path, access, s)]).toEqual([path, access, false]);
    // A search from the home (Glob's and Grep's walk asks the same check of each folder before it lists it) skips Mail.
    expect(allowed(join(user, "Library"), "read", s)).toBe(true);
    expect(allowed(join(user, "Library", "Mail"), "read", s)).toBe(false);
  });

  test("each secret place's spelling: on its own name, or on the folder above when that one can't be opened either", () => {
    const { user, lock } = mac();
    lock("Library/Mail");
    lock("Library/Containers");
    const forms = runtimeDenyForms([join(user, "Library/Mail"), join(user, "Library/Containers/com.apple.Safari"), join(user, ".ssh"), join(user, "Documents")], { os: "macos", userHome: user });
    expect(forms).toEqual([
      join(user, "Library/[mM][aA][iI][lL]"),
      join(user, "Library/[cC][oO][nN][tT][aA][iI][nN][eE][rR][sS]/com.apple.Safari"),
      join(user, ".[sS][sS][hH]"),
      join(user, "Documents"),
    ]);
    // Elsewhere than macOS, as they are.
    expect(runtimeDenyForms([join(user, "Library/Mail")], { os: "linux", userHome: user })).toEqual([join(user, "Library/Mail")]);
  });

  test("every secret place, there or not: the check resolves it, and refuses it and what's under it, in any case", async () => {
    const allowed = await runtimeCheck();
    const { user } = mac();
    const places = secretReadPlaces("macos", user).map((p) => p.path);
    const s = { filesystem: { denyRead: runtimeDenyForms(places, { os: "macos", userHome: user }), denyWrite: runtimeDenyForms(places, { os: "macos", userHome: user }) } };
    expect(allowed(join(user, "Desktop", "a.md"), "write", s)).toBe(true);
    for (const p of places) {
      for (const path of [p, join(p, "x"), p.toUpperCase(), join(p.toLowerCase(), "x")]) {
        expect([path, allowed(path, "read", s), allowed(path, "write", s)]).toEqual([path, false, false]);
      }
    }
    // A name that only starts like one is not it.
    expect(allowed(join(user, "Library", "Mailboxes", "x"), "read", s)).toBe(true);
    expect(allowed(join(user, ".sshx"), "read", s)).toBe(true);
  });

  test("a `.DS_Store` among the bots' scratch folders: no kept folder, pin or hold under it, and the file tools work", async () => {
    const allowed = await runtimeCheck();
    const { user, clover } = mac();
    const drawn = alphaSandbox(user, clover, false);
    const all = [...drawn.filesystem!.allowWrite!, ...drawn.filesystem!.denyWrite!, ...drawn.filesystem!.denyRead!];
    for (const f of [join(clover, "scratch", ".DS_Store"), join(clover, "bots", ".DS_Store")]) {
      expect(all.filter((e) => e.startsWith(`${f}/`))).toEqual([]);
      expect(drawn.filesystem!.allowWrite).not.toContain(f);
    }
    expect(drawn.filesystem!.denyWrite).toContain(join(clover, "scratch", "alpha", KEPT_FOLDER_PIN));
    expect(allowed(join(user, "Desktop", "hello_world.md"), "write", drawn as never)).toBe(true);
    expect(allowed(join(clover, "scratch", "alpha", "draft.md"), "write", drawn as never)).toBe(true);
  });

  test("an entry under a file (one an older build drew) is spelled so it resolves, and still denies its place", async () => {
    const allowed = await runtimeCheck();
    const { clover, user } = mac();
    const under = join(clover, "scratch", ".DS_Store", KEPT_FOLDER_PIN);
    const s = { filesystem: { denyWrite: runtimeDenyForms([under, `${join(clover, "scratch", ".DS_Store")}/**/*.git/hooks`], { os: "macos", userHome: user }) } };
    expect(allowed(join(user, "Desktop", "a.md"), "write", { filesystem: { denyWrite: [under] } })).toBe(false);
    expect(allowed(join(user, "Desktop", "a.md"), "write", s)).toBe(true);
    expect(allowed(under, "write", s)).toBe(false);
  });
});
