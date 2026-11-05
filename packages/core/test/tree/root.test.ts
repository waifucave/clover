// The tree on each computer's own disk: this computer's own entry is a link to its home folder, `bots/` to its bots'
// folder, nothing else is there, and `home/` is read-only (spec §9.1 "Same-computer paths are native").
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContractError } from "../../src/contracts/common";
import { defaultTreeRoot, ensureTreeRoot, treeHomeWritable } from "../../src/tree/root";

/** Whether this process runs as an elevated administrator (Windows). */
async function elevated(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const script = "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)";
  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  return (await new Response(proc.stdout).text()).trim() === "True";
}

describe("the tree folder", () => {
  test("home/<this computer> is the home folder; other computers aren't on disk; home/ is read-only", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "lane-j-root-")));
    const home = join(base, "home");
    mkdirSync(join(home, "project"), { recursive: true });
    writeFileSync(join(home, "project", "a.txt"), "native");
    const root = join(base, "tree");
    const botsRoot = join(home, ".clover", "bots");
    await ensureTreeRoot({ root, self: "Studio", home, botsRoot });
    expect(readFileSync(join(root, "home", "Studio", "project", "a.txt"), "utf8")).toBe("native");
    expect(readdirSync(join(root, "home"))).toEqual(["Studio"]);
    expect(existsSync(join(root, "home", "Laptop1"))).toBe(false);
    expect(realpathSync(join(root, "bots"))).toBe(realpathSync(botsRoot));
    // On Windows an elevated administrator (the CI runner) passes the access list's deny; the next test reads the
    // list itself.
    if (process.platform !== "win32" || !(await elevated())) {
      expect(await treeHomeWritable(root)).toBe(false);
      expect(() => writeFileSync(join(root, "home", "Laptop1"), "x")).toThrow();
      expect(() => mkdirSync(join(root, "home", "Laptop1"))).toThrow();
    }
    // A rename moves the link, and leaves no other.
    await ensureTreeRoot({ root, self: "Studio-2", home, botsRoot });
    expect(readdirSync(join(root, "home"))).toEqual(["Studio-2"]);
    expect(readFileSync(join(root, "home", "Studio-2", "project", "a.txt"), "utf8")).toBe("native");
  });

  test("on Windows: owned by the user, a protected access list for the user and SYSTEM only, home\\ closed to new entries", async () => {
    if (process.platform !== "win32") return;
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), "lane-j-root-")));
    const home = join(base, "home");
    mkdirSync(home, { recursive: true });
    const root = join(base, "tree");
    await ensureTreeRoot({ root, self: "Studio", home, botsRoot: join(home, ".clover", "bots") });
    const acl = async (p: string) => {
      const script = `$a = Get-Acl -LiteralPath $env:P; 'protected=' + $a.AreAccessRulesProtected; foreach ($r in $a.Access) { $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value + ' ' + $r.AccessControlType + ' ' + $r.FileSystemRights }; 'me=' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value`;
      const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, P: p }, stdout: "pipe", stderr: "pipe", windowsHide: true });
      return (await new Response(proc.stdout).text()).trim().split(/\r?\n/);
    };
    const r = await acl(root);
    const me = r.find((l) => l.startsWith("me="))!.slice(3);
    expect(r[0]).toBe("protected=True");
    const sids = r.slice(1, -1).map((l) => l.split(" ")[0]);
    expect(new Set(sids)).toEqual(new Set([me, "S-1-5-18"]));
    const h = await acl(join(root, "home"));
    expect(h[0]).toBe("protected=True");
    expect(h.some((l) => l.startsWith("S-1-1-0 Deny"))).toBe(true);
    // Made again (a rename), it stays closed.
    await ensureTreeRoot({ root, self: "Studio-2", home, botsRoot: join(home, ".clover", "bots") });
    expect(readdirSync(join(root, "home"))).toEqual(["Studio-2"]);
    const again = await acl(join(root, "home"));
    expect(again[0]).toBe("protected=True");
    expect(again.some((l) => l.startsWith("S-1-1-0 Deny"))).toBe(true);
    if (!(await elevated())) expect(await treeHomeWritable(root)).toBe(false);
    else console.log(`lane-j: an elevated administrator can${(await treeHomeWritable(root)) ? "" : "'t"} make a folder in home\\ past its deny`);
  });

  test("where it lives on each OS, outside every home folder", () => {
    expect(defaultTreeRoot({ XDG_RUNTIME_DIR: "/run/user/1000" }, "linux")).toBe("/run/user/1000/clover");
    expect(isContractError((() => { try { defaultTreeRoot({}, "linux"); } catch (e) { return e; } })(), "invalid")).toBe(true);
    expect(defaultTreeRoot({}, "macos")).toMatch(/^\/Users\/Shared\/clover-\d+$/);
    expect(defaultTreeRoot({ ProgramData: "C:\\ProgramData", USERNAME: "me" }, "windows")).toBe("C:\\ProgramData\\Clover\\tree-me");
  });
});
