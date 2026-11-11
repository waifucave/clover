// The user's secret places (`SECRET_READ_PLACES`, the coordinator's ruling of November 11): a bot's Read, Grep and
// Glob never read one, by any path (a link from its own folder, a case variant, a place that is itself a link), and
// are refused with no card at every level; a search from above runs, skips them and says how many it skipped, naming
// no path in them; a link inside a place that points out is judged where it points. The refusal names the class only.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Level, Os } from "@waifucave/clover-protocol";
import { CloverApprovalBroker } from "../../src/approvals/broker";
import { botApprovalCheck } from "../../src/approvals/bot-check";
import { CREDENTIAL_FILES, SECRET_READ_PLACES, secretReadPlaces } from "../../src/contracts/fence";
import { FakeClock } from "../../src/contracts/fakes/clock";
import { CloverFence } from "../../src/fence/fence";
import { secretPlaceOf, secretPlacesUnder } from "../../src/fence/secret-reads";
import { CREDENTIAL_FILES as PLUGIN_CREDENTIAL_FILES } from "../../src/registry/plugin-fence";
import { botFileFence } from "../../src/runtime-sdk/turn-loop/driver";
import { fenceSearchOutput, fileToolFenceRefusal } from "../../src/runtime-sdk/turn-loop/file-fence";
import type { BotSessionContext } from "../../src/bots/service";

const os: Os = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** One file per class, as a fake user's home holds them (no real home, no real Keychain). */
const SAMPLES: readonly { file: string; cls: string; os?: Os }[] = [
  { file: ".ssh/id_ed25519", cls: "SSH or GPG keys" },
  { file: ".gnupg/private-keys-v1.d/k.key", cls: "SSH or GPG keys" },
  { file: ".aws/credentials", cls: "cloud credentials" },
  { file: ".kube/config", cls: "cloud credentials" },
  { file: ".docker/config.json", cls: "cloud credentials" },
  { file: ".config/gh/hosts.yml", cls: "a developer tool's sign-in" },
  { file: ".netrc", cls: "a developer tool's sign-in" },
  { file: ".npmrc", cls: "a package registry's token" },
  { file: ".cargo/credentials.toml", cls: "a package registry's token" },
  { file: ".codex/auth.json", cls: "a coding agent's sign-in" },
  { file: ".claude/.credentials.json", cls: "a coding agent's sign-in" },
  { file: ".zsh_history", cls: "shell history" },
  { file: "Library/Keychains/login.keychain-db", cls: "the Keychain", os: "macos" },
  { file: "Library/Application Support/Google/Chrome/Default/Cookies", cls: "a browser's cookies and saved logins", os: "macos" },
  { file: "Library/Application Support/Firefox/Profiles/x/logins.json", cls: "a browser's cookies and saved logins", os: "macos" },
  { file: "Library/Application Support/1Password/data.sqlite", cls: "a password manager's store", os: "macos" },
  { file: "Library/Application Support/Slack/Cookies", cls: "an app's sign-in tokens", os: "macos" },
  { file: ".config/google-chrome/Default/Cookies", cls: "a browser's cookies and saved logins", os: "linux" },
];
const samples = SAMPLES.filter((s) => s.os === undefined || s.os === os);
const CONTENT = "TOPSECRET-VALUE";

function world() {
  const user = realpathSync(mkdtempSync(join(tmpdir(), "lane-c-secrets-")));
  temps.push(user);
  const clover = join(user, ".clover");
  const scratch = join(clover, "scratch", "luna");
  mkdirSync(scratch, { recursive: true });
  for (const s of samples) {
    mkdirSync(dirname(join(user, s.file)), { recursive: true });
    writeFileSync(join(user, s.file), CONTENT);
  }
  mkdirSync(join(user, "Projects", "app"), { recursive: true });
  writeFileSync(join(user, "Projects", "app", "notes.md"), "ordinary");
  // A link from the bot's own folder to a secret file, and one inside a secret place that points out of it.
  symlinkSync(join(user, ".aws", "credentials"), join(scratch, "creds"));
  symlinkSync(join(user, "Projects", "app", "notes.md"), join(user, ".ssh", "notes-link"));
  const ctx = {
    botId: "luna", sessionId: "s1", computer: "Studio", paths: { scratch, root: dirname(scratch) },
    caller: { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "luna" },
  } as unknown as BotSessionContext;
  const fence = new CloverFence({ home: user, cloverHome: clover });
  const fileFence = botFileFence(fence, clover, os, user)(ctx);
  const refused = (name: string, input: Record<string, unknown>) => fileToolFenceRefusal(name, input, fileFence, scratch);
  return { user, clover, scratch, ctx, fence, fileFence, refused };
}

describe("the one list", () => {
  test("the plugin fence's credential files are the list's own (one list), and every entry is relative, with no wildcard", () => {
    expect(PLUGIN_CREDENTIAL_FILES).toBe(CREDENTIAL_FILES);
    for (const f of CREDENTIAL_FILES) expect(SECRET_READ_PLACES.some((p) => p.path === f)).toBe(true);
    for (const p of SECRET_READ_PLACES) {
      expect(p.path.startsWith("/") || p.path.includes("*") || p.path.includes("..")).toBe(false);
    }
    // git's own configs stay readable (git stops when its global config can't be read).
    for (const keep of [".gitconfig", ".config/git/config", ".config/git"]) expect(SECRET_READ_PLACES.some((p) => p.path === keep)).toBe(false);
    expect(secretReadPlaces("macos", "/Users/u").some((p) => p.path === "/Users/u/Library/Keychains")).toBe(true);
    expect(secretReadPlaces("linux", "/home/u").some((p) => p.path.includes("Library"))).toBe(false);
  });
});

describe("a bot's Read, Grep and Glob (the driver's file fence)", () => {
  test("every class is refused by its path, with the class named, the user's way out said, and nothing of the file", () => {
    const w = world();
    for (const s of samples) {
      const why = w.refused("Read", { file_path: join(w.user, s.file) });
      expect([s.file, why]).toEqual([s.file, expect.stringContaining(`holds ${s.cls}`)]);
      expect(why).toContain("paste the value");
      expect(why).not.toContain(CONTENT);
    }
  });

  test("through a link from the bot's own folder, as a case variant, and through a place that is itself a link", () => {
    const w = world();
    expect(w.refused("Read", { file_path: join(w.scratch, "creds") })).toContain("cloud credentials");
    expect(w.refused("Read", { file_path: "creds" })).toContain("cloud credentials");
    if (os === "macos") expect(w.refused("Read", { file_path: join(w.user, ".AWS", "credentials") })).toContain("cloud credentials");
    // `~/.gnupg` moved into a dotfiles folder and linked back: what is there is the place's, by either path.
    const dot = join(w.user, "dotfiles", "gnupg");
    mkdirSync(dot, { recursive: true });
    writeFileSync(join(dot, "secring.gpg"), CONTENT);
    rmSync(join(w.user, ".gnupg"), { recursive: true, force: true });
    symlinkSync(dot, join(w.user, ".gnupg"));
    expect(w.refused("Read", { file_path: join(w.user, ".gnupg", "secring.gpg") })).toContain("SSH or GPG keys");
    expect(w.refused("Read", { file_path: join(dot, "secring.gpg") })).toContain("SSH or GPG keys");
  });

  test("a link inside a secret place that points out of it is judged where it points: readable", () => {
    const w = world();
    expect(w.refused("Read", { file_path: join(w.user, ".ssh", "notes-link") })).toBeUndefined();
    expect(w.refused("Read", { file_path: join(w.user, "Projects", "app", "notes.md") })).toBeUndefined();
  });

  test("a search inside a place, or whose pattern starts in one, is refused; one from above runs", () => {
    const w = world();
    expect(w.refused("Grep", { pattern: "x", path: join(w.user, ".aws") })).toContain("cloud credentials");
    expect(w.refused("Glob", { pattern: `${w.user}/.ssh/*` })).toContain("SSH or GPG keys");
    expect(w.refused("Grep", { pattern: "x", path: w.user, glob: `${w.user}/.aws/*` })).toContain("cloud credentials");
    expect(w.refused("Grep", { pattern: "x", path: w.user })).toBeUndefined();
    expect(w.refused("Glob", { pattern: "**/*", path: w.user })).toBeUndefined();
  });

  test("a search from above: hits in secret places dropped, and a note says how many places were skipped, naming none", () => {
    const w = world();
    const own = join(w.user, "Projects", "app", "notes.md");
    const creds = join(w.user, ".aws", "credentials");
    const n = secretPlacesUnder(w.user, { userHome: w.user, os, cwd: w.scratch });
    expect(n).toBeGreaterThan(5);
    const glob = fenceSearchOutput("Glob", [own, creds, join(w.scratch, "creds")].join("\n"), w.fileFence, w.scratch, { pattern: "**/*", path: w.user })!;
    expect(glob.split("\n")).toEqual([own, `(${n} protected places skipped: credentials, keys and sign-ins a bot never reads)`]);
    const grep = fenceSearchOutput("Grep", JSON.stringify({ mode: "content", content: [{ file: own, text: "ordinary" }, { file: creds, text: CONTENT }] }), w.fileFence, w.scratch, { pattern: "x", path: w.user })!;
    expect(grep).not.toContain(CONTENT);
    const parsed = JSON.parse(grep) as { content: unknown[]; note: string };
    expect(parsed.content).toEqual([{ file: own, text: "ordinary" }]);
    expect(parsed.note).toContain(`${n} protected places skipped`);
    for (const out of [glob, parsed.note]) expect(out.includes("/.aws") || out.includes("/.ssh") || out.includes("Keychains")).toBe(false);
    // A search of a folder that holds none: no note, nothing changed.
    expect(fenceSearchOutput("Glob", own, w.fileFence, w.scratch, { pattern: "**/*", path: join(w.user, "Projects") })).toBeUndefined();
  });

  test("secretPlaceOf: the place really reached decides, as written and as it really is", () => {
    const w = world();
    const o = { userHome: w.user, os, cwd: w.scratch };
    expect(secretPlaceOf(join(w.scratch, "creds"), o)).toBe("cloud credentials");
    expect(secretPlaceOf(join(w.user, ".ssh", "notes-link"), o)).toBeUndefined();
    // A file not there yet, in a place: the place's.
    expect(secretPlaceOf(join(w.user, ".aws", "new"), o)).toBe("cloud credentials");
  });
});

describe("the approvals (bot-check): refused with no card, at every level, for any tool that reads a path", () => {
  for (const level of ["ask-risky", "accept-edits", "automatic"] as Level[]) {
    test(`at ${level}`, async () => {
      const w = world();
      const broker = new CloverApprovalBroker({ clock: new FakeClock(), levels: () => level, localComputer: "Studio", fence: () => w.fence });
      const check = botApprovalCheck(broker, { home: w.user, localComputer: "Studio", fence: w.fence, cloverHome: w.clover, levelOf: () => level, commandsAlwaysCard: true })(w.ctx, () => "user");
      const call = (tool: string, input: Record<string, unknown>) => check(tool, input, { signal: new AbortController().signal, toolUseID: "t1", requestId: "r1" });
      for (const s of samples) {
        const d = await call("Read", { file_path: join(w.user, s.file) });
        expect([s.file, d?.behavior]).toEqual([s.file, "deny"]);
        expect((d as { message: string }).message).toContain(`holds ${s.cls}`);
      }
      expect((await call("Read", { file_path: join(w.scratch, "creds") }))?.behavior).toBe("deny");
      expect((await call("NotebookRead", { notebook_path: join(w.user, ".aws", "credentials") }))?.behavior).toBe("deny");
      expect((await call("Grep", { pattern: "x", path: join(w.user, ".config", "gh") }))?.behavior).toBe("deny");
      expect(broker.cards()).toEqual([]);
      // An ordinary file reads as before.
      expect((await call("Read", { file_path: join(w.user, "Projects", "app", "notes.md") }))?.behavior).toBe("allow");
      expect((await call("Read", { file_path: join(w.user, ".ssh", "notes-link") }))?.behavior).toBe("allow");
    });
  }
});
