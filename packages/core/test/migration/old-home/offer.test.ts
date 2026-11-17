// The offer and its notice (`offer.ts`), the one function that says where the old home is (`locate.ts`), the old
// engine's liveness (`alive.ts`) and its login item (`login-item.ts`): fixtures and fakes only.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalDecision, ApprovalRequest } from "../../../src/contracts/approval-broker";
import { oldEndpoint, oldEngineAlive } from "../../../src/migration/old-home/alive";
import { markFresh, readChoice, writeChoice } from "../../../src/migration/old-home/choice";
import { OLD_HOME_ENV, oldHomeFor } from "../../../src/migration/old-home/locate";
import { disableOldLoginItem, oldBinaryPlaces, oldEngineRequirement, oldLoginItem } from "../../../src/migration/old-home/login-item";
import { OLD_ENGINE_HOME_ENV, OLD_SYSTEMD_UNIT } from "../../../src/migration/old-home/names";
import { OFFER_TEXT, runOldHomeOffer } from "../../../src/migration/old-home/offer";
import { oldHomePaths } from "../../../src/migration/old-home/paths";
import { applyStagedCopy } from "../../../src/migration/old-home/swap";
import { OLD_APP_BUNDLE_DIR, OLD_INSTALL_HOME_DIR, OLD_INSTALL_LOGIN_LABEL } from "../../../src/other-installs";
import { darwinTest } from "../../helpers/darwin-only";
import { buildOldHome, treeHash } from "./fixture";

const dirs: string[] = [];
const servers: Server[] = [];
function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A broker that answers each card with the next option id, and keeps what it was asked. */
function fakeBroker(answers: (string | "unanswered")[]) {
  const asked: ApprovalRequest[] = [];
  return {
    asked,
    request: async (req: ApprovalRequest): Promise<ApprovalDecision> => {
      asked.push(req);
      const a = answers.shift();
      if (a === undefined || a === "unanswered") return { allowed: false, by: "cancelled" };
      const opt = req.options?.find((o) => o.id === a);
      if (opt === undefined) throw new Error(`the card offers no ${a} (${req.options?.map((o) => o.id).join(", ")})`);
      return { allowed: opt.kind === "approve", by: "card", optionId: a, cardId: `card_${asked.length}` };
    },
  };
}

const titleOf = (req: ApprovalRequest) => (req.fields.title as { text: string }).text;

function setup() {
  const root = temp("moss-old-home-offer-");
  const user = join(root, "user");
  const fx = buildOldHome(user, join(root, "scratch"), OLD_INSTALL_HOME_DIR);
  const home = join(root, "new-home");
  mkdirSync(home, { recursive: true });
  markFresh(home, 1);
  return { root, user, old: fx.old, home };
}

describe("the offer", () => {
  test("one card drawn by the core; bring it over stages the copy and asks for the restart; the next start swaps it in", async () => {
    const { old, home } = setup();
    const before = treeHash(old);
    const broker = fakeBroker(["copy"]);
    let restarts = 0;
    const outcome = await runOldHomeOffer({ home, oldHome: old, broker, alive: async () => ({ alive: false }), requestRestart: () => restarts++, loginItem: () => undefined });
    expect(outcome).toBe("staged");
    expect(restarts).toBe(1);
    expect(broker.asked).toHaveLength(1);
    const req = broker.asked[0]!;
    expect(req).toMatchObject({ kind: "change", change: "home-copy", origin: "user", computers: [], effect: "other" });
    expect(req.pluginId).toBeUndefined();
    expect(titleOf(req)).toBe(OFFER_TEXT.offer.title);
    expect(req.options).toEqual([{ id: "copy", kind: "approve", label: OFFER_TEXT.offer.copy }, { id: "fresh", kind: "deny", label: OFFER_TEXT.offer.fresh }]);
    expect(applyStagedCopy(home).kind).toBe("swapped");
    expect(treeHash(old)).toBe(before);
    // The next start: the notice, once, naming what to set up again; then nothing more.
    const notice = fakeBroker(["ok"]);
    expect(await runOldHomeOffer({ home, oldHome: old, broker: notice, alive: async () => ({ alive: false }), loginItem: () => undefined })).toBe("notice-shown");
    const lines = (notice.asked[0]!.fields.detail as { items: string[] }).items;
    expect(titleOf(notice.asked[0]!)).toBe(OFFER_TEXT.notice.title);
    expect(lines[0]).toContain("Anthropic");
    expect(lines.join("\n")).toContain("Pocket (phone)");
    expect(lines).toContain(OFFER_TEXT.notice.plugins);
    expect(lines).toContain(OFFER_TEXT.notice.kept);
    expect(notice.asked[0]!.options).toEqual([{ id: "ok", kind: "approve", label: OFFER_TEXT.notice.ok }]);
    const again = fakeBroker([]);
    expect(await runOldHomeOffer({ home, oldHome: old, broker: again, alive: async () => ({ alive: false }) })).toBe("already-chosen");
    expect(again.asked).toHaveLength(0);
  });

  test("start fresh is remembered in the new home and never asked again; nothing of the old home is copied", async () => {
    const { old, home } = setup();
    const broker = fakeBroker(["fresh"]);
    expect(await runOldHomeOffer({ home, oldHome: old, broker, alive: async () => ({ alive: false }) })).toBe("fresh");
    expect(readChoice(home)?.choice).toBe("fresh");
    expect(existsSync(oldHomePaths(home).staging)).toBe(false);
    const again = fakeBroker([]);
    expect(await runOldHomeOffer({ home, oldHome: old, broker: again, alive: async () => ({ alive: false }) })).toBe("already-chosen");
    expect(again.asked).toHaveLength(0);
  });

  test("while the old engine runs: quit it first, check again; no partial copy, and the copy runs once it is gone", async () => {
    const { old, home } = setup();
    let running = true;
    // Checked twice while it runs; the person quits it before the third check, then brings the data over.
    const broker = fakeBroker(["check", "check", "copy"]);
    const outcome = await runOldHomeOffer({
      home, oldHome: old, broker, loginItem: () => undefined, requestRestart: () => {},
      alive: async () => {
        if (broker.asked.length >= 2) running = false;
        return running ? { alive: true, how: "its endpoint answers" } : { alive: false };
      },
    });
    expect(broker.asked.map(titleOf)).toEqual([OFFER_TEXT.running.title, OFFER_TEXT.running.title, OFFER_TEXT.offer.title]);
    expect(broker.asked[0]!.options?.map((o) => o.id)).toEqual(["check", "fresh"]);
    expect((broker.asked[0]!.fields.detail as { items: string[] }).items).toEqual([...OFFER_TEXT.running.detail]);
    expect(outcome).toBe("staged");
  });

  test("while it runs, nothing is staged", async () => {
    const { old, home } = setup();
    const broker = fakeBroker(["check", "unanswered"]);
    expect(await runOldHomeOffer({ home, oldHome: old, broker, alive: async () => ({ alive: true }) })).toBe("unanswered");
    expect(existsSync(oldHomePaths(home).staging)).toBe(false);
    expect(readChoice(home)).toBeUndefined();
  });

  test("a press that finds the old engine started meanwhile copies nothing and says to quit it", async () => {
    const { old, home } = setup();
    const states = [false, true, true];
    const broker = fakeBroker(["copy", "fresh"]);
    expect(await runOldHomeOffer({ home, oldHome: old, broker, alive: async () => ({ alive: states.shift() ?? true }) })).toBe("fresh");
    expect(broker.asked.map(titleOf)).toEqual([OFFER_TEXT.offer.title, OFFER_TEXT.running.title]);
    expect(existsSync(oldHomePaths(home).staging)).toBe(false);
  });

  test("never on a home that wasn't new, nor with no old home", async () => {
    const { old, home } = setup();
    rmSync(oldHomePaths(home).fresh);
    const broker = fakeBroker([]);
    expect(await runOldHomeOffer({ home, oldHome: old, broker, alive: async () => ({ alive: false }) })).toBe("not-fresh");
    markFresh(home, 1);
    expect(await runOldHomeOffer({ home, oldHome: join(home, "nothing-here"), broker, alive: async () => ({ alive: false }) })).toBe("no-old-home");
    expect(broker.asked).toHaveLength(0);
  });

  test("the notice offers the old engine's own autostart disable when its login item serves the copied home", async () => {
    const { old, home } = setup();
    writeChoice(home, { v: 1, choice: "copied", at: 1, from: old });
    const ran: string[] = [];
    const broker = fakeBroker(["login-off"]);
    const item = { bin: "/old/engine", file: "/the/plist" };
    expect(await runOldHomeOffer({ home, oldHome: old, broker, alive: async () => ({ alive: false }), loginItem: () => item, disableLoginItem: async (i) => (ran.push(i.bin), { ok: true }) })).toBe("notice-shown");
    expect(ran).toEqual(["/old/engine"]);
    expect(broker.asked[0]!.options?.map((o) => o.id)).toEqual(["login-off", "leave"]);
    expect((broker.asked[0]!.fields.detail as { items: string[] }).items).toContain(OFFER_TEXT.notice.login);
    // It refused: said, and moved on.
    writeChoice(home, { v: 1, choice: "copied", at: 1, from: old });
    const b2 = fakeBroker(["login-off", "ok"]);
    expect(await runOldHomeOffer({ home, oldHome: old, broker: b2, alive: async () => ({ alive: false }), loginItem: () => item, disableLoginItem: async () => ({ ok: false, why: "a test build never registers a login item" }) })).toBe("notice-shown");
    expect((b2.asked[1]!.fields.what as { text: string }).text).toBe(OFFER_TEXT.loginFailed("a test build never registers a login item"));
    // Unanswered (a stop cancelled it): said again at the next start.
    writeChoice(home, { v: 1, choice: "copied", at: 1, from: old });
    expect(await runOldHomeOffer({ home, oldHome: old, broker: fakeBroker(["unanswered"]), alive: async () => ({ alive: false }), loginItem: () => undefined })).toBe("unanswered");
    expect(readChoice(home)).toEqual({ v: 1, choice: "copied", at: 1, from: old });
  });
});

describe("where the old home is", () => {
  const fakeHome = () => "/Users/fake-person";
  test("the real profile on its own default home: the old app's home under the user's home", () => {
    expect(oldHomeFor({ home: "/Users/fake-person/.moss", profile: "dist", env: {}, homedir: fakeHome, distBuild: true, testBuild: false })).toEqual({ path: join("/Users/fake-person", OLD_INSTALL_HOME_DIR), via: "default" });
  });
  test("no override and a dev profile, a test-marked build or another home: nothing (so nothing is read)", () => {
    expect(oldHomeFor({ home: "/Users/fake-person/.moss-dev", profile: "dev", env: {}, homedir: fakeHome, distBuild: false, testBuild: false }).path).toBeUndefined();
    expect(oldHomeFor({ home: "/Users/fake-person/.moss", profile: "dev", env: {}, homedir: fakeHome, distBuild: false, testBuild: false }).path).toBeUndefined();
    expect(oldHomeFor({ home: "/Users/fake-person/.moss", profile: "dist", env: {}, homedir: fakeHome, distBuild: true, testBuild: true }).path).toBeUndefined();
    expect(oldHomeFor({ home: "/tmp/some-test-home", profile: "dist", env: {}, homedir: fakeHome, distBuild: false, testBuild: false }).path).toBeUndefined();
    // A source run on the real profile's own default home: nothing, without the override.
    expect(oldHomeFor({ home: "/Users/fake-person/.moss", profile: "dist", env: {}, homedir: fakeHome, distBuild: false, testBuild: false })).toEqual({ path: undefined, why: "an engine run from source reads no old home without the override" });
  });
  test("the override names a fixture in a source or test-marked build, and a release build ignores it", () => {
    const env = { [OLD_HOME_ENV]: "/tmp/fixture-old" };
    expect(oldHomeFor({ home: "/tmp/h", profile: "dev", env, homedir: fakeHome, distBuild: false, testBuild: false })).toEqual({ path: "/tmp/fixture-old", via: "override" });
    expect(oldHomeFor({ home: "/tmp/h", profile: "dist", env, homedir: fakeHome, distBuild: true, testBuild: true })).toEqual({ path: "/tmp/fixture-old", via: "override" });
    const said: string[] = [];
    expect(oldHomeFor({ home: "/tmp/h", profile: "dist", env, homedir: fakeHome, distBuild: true, testBuild: false, log: (l) => said.push(l) }).path).toBeUndefined();
    expect(said.join("")).toContain(OLD_HOME_ENV);
    expect(oldHomeFor({ home: "/tmp/h", profile: "dev", env: { [OLD_HOME_ENV]: "/tmp/h" }, homedir: fakeHome, distBuild: false, testBuild: false }).path).toBeUndefined();
  });
  test("this test run's own override is an empty throwaway folder, never the real old home", () => {
    const o = process.env[OLD_HOME_ENV]!;
    expect(o).toBeDefined();
    expect(o.startsWith(join(homedir(), OLD_INSTALL_HOME_DIR))).toBe(false);
    expect(readdirSync(o)).toEqual([]);
  });
});

describe("the old engine's liveness, read only", () => {
  test("its socket answering, or its lock naming a live process beside its socket; neither, not running", async () => {
    if (process.platform === "win32") return; // a named pipe there, not a socket file
    const old = temp("moss-old-alive-");
    mkdirSync(join(old, "run"));
    expect(await oldEngineAlive(old)).toEqual({ alive: false });
    // A live pid recorded, but no endpoint file: a stale lock.
    writeFileSync(join(old, "run", "core.lock"), JSON.stringify({ pid: process.ppid }));
    expect((await oldEngineAlive(old)).alive).toBe(false);
    // Listening on its socket (a server this test started).
    const sock = oldEndpoint(old);
    const server = createServer(() => {});
    servers.push(server);
    await new Promise<void>((r) => server.listen(sock, r));
    expect(await oldEngineAlive(old)).toEqual({ alive: true, how: "its endpoint answers" });
    expect(await oldEngineAlive(old, { answers: async () => false, pidAlive: () => true })).toEqual({ alive: true, how: `its lock names a live process (${process.ppid})` });
    expect((await oldEngineAlive(old, { answers: async () => false, pidAlive: () => false })).alive).toBe(false);
  });
  test("the lock file is only read: it is neither locked nor written", async () => {
    const old = temp("moss-old-alive-");
    mkdirSync(join(old, "run"));
    writeFileSync(join(old, "run", "core.lock"), JSON.stringify({ pid: 999_999_999 }));
    const before = treeHash(old);
    await oldEngineAlive(old);
    expect(treeHash(old)).toBe(before);
  });
});

describe("the old login item", () => {
  function plist(user: string, bin: string, home: string | undefined): void {
    const dir = join(user, "Library", "LaunchAgents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${OLD_INSTALL_LOGIN_LABEL}.plist`), `<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${bin}</string>\n    <string>supervise</string>\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>${home === undefined ? "" : `<key>${OLD_ENGINE_HOME_ENV}</key><string>${home}</string>`}</dict>\n</dict>\n</plist>\n`);
  }
  test("macOS: found from its plist when it serves the copied home and its program is there", () => {
    const user = temp("moss-old-login-");
    const old = join(user, OLD_INSTALL_HOME_DIR);
    mkdirSync(old);
    const bin = join(user, "old-engine");
    writeFileSync(bin, "#!/bin/sh\n");
    expect(oldLoginItem(old, "darwin")).toBeUndefined();
    plist(user, bin, old);
    expect(oldLoginItem(old, "darwin")).toEqual({ bin, file: join(user, "Library", "LaunchAgents", `${OLD_INSTALL_LOGIN_LABEL}.plist`) });
    plist(user, bin, join(user, "elsewhere"));
    expect(oldLoginItem(old, "darwin")).toBeUndefined();
    plist(user, join(user, "gone"), old);
    expect(oldLoginItem(old, "darwin")).toBeUndefined();
    plist(user, bin, undefined);
    expect(oldLoginItem(old, "darwin")?.bin).toBe(bin);
  });
  test("Linux: found from its systemd unit when it is enabled", () => {
    const user = temp("moss-old-login-");
    const old = join(user, OLD_INSTALL_HOME_DIR);
    mkdirSync(old);
    const bin = join(user, "old-engine");
    writeFileSync(bin, "#!/bin/sh\n");
    const units = join(user, ".config", "systemd", "user");
    mkdirSync(join(units, "default.target.wants"), { recursive: true });
    writeFileSync(join(units, OLD_SYSTEMD_UNIT), `[Service]\nExecStart=${bin} supervise\nEnvironment="${OLD_ENGINE_HOME_ENV}=${old}"\n`);
    expect(oldLoginItem(old, "linux")).toBeUndefined();
    writeFileSync(join(units, "default.target.wants", OLD_SYSTEMD_UNIT), "");
    expect(oldLoginItem(old, "linux")).toEqual({ bin, file: join(units, OLD_SYSTEMD_UNIT) });
    expect(oldLoginItem(old, "win32")).toBeUndefined();
  });
  test("its own autostart disable, run with a plain environment naming the old home; a refusal says why", async () => {
    if (process.platform === "win32") return; // the stand-in program is a shell script
    const user = temp("moss-old-login-");
    const old = join(user, OLD_INSTALL_HOME_DIR);
    mkdirSync(join(old, "bin"), { recursive: true });
    const bin = join(old, "bin", "old-engine");
    const out = join(user, "ran.txt");
    writeFileSync(bin, `#!/bin/sh\necho "$@ ${OLD_ENGINE_HOME_ENV}=$${OLD_ENGINE_HOME_ENV} MOSS_HOME=$MOSS_HOME" > "${out}"\n`);
    chmodSync(bin, 0o755);
    const signed = { verify: () => true };
    process.env.MOSS_HOME_PROBE_SHOULD_NOT_PASS = "dummy123";
    expect(await disableOldLoginItem({ bin, file: "x" }, old, signed)).toEqual({ ok: true });
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(out, "utf8").trim()).toBe(`autostart disable ${OLD_ENGINE_HOME_ENV}=${old} MOSS_HOME=`);
    writeFileSync(bin, "#!/bin/sh\necho 'this build never registers a login item' >&2\nexit 1\n");
    expect(await disableOldLoginItem({ bin, file: "x" }, old, signed)).toEqual({ ok: false, why: "this build never registers a login item" });
    rmSync(bin);
    expect((await disableOldLoginItem({ bin, file: "x" }, old, signed)).ok).toBe(false);
    delete process.env.MOSS_HOME_PROBE_SHOULD_NOT_PASS;
  });
  test("the press runs only the old engine's own binary: in its app or its folder's bin, and signed as its own", async () => {
    if (process.platform === "win32") return; // the stand-in program is a shell script
    const user = temp("moss-old-login-");
    const old = join(user, OLD_INSTALL_HOME_DIR);
    mkdirSync(join(old, "bin"), { recursive: true });
    const ran: string[] = [];
    const run = async (b: string) => { ran.push(b); return { code: 0, out: "" }; };
    const elsewhere = join(user, "planted");
    writeFileSync(elsewhere, "#!/bin/sh\n");
    chmodSync(elsewhere, 0o755);
    // A plist naming a program outside both places: refused, nothing runs.
    const outside = await disableOldLoginItem({ bin: elsewhere, file: "x" }, old, { run, verify: () => true });
    expect(outside.ok).toBe(false);
    expect(outside.why).toContain("isn't");
    // A link in the bin folder that leads out: its real path decides.
    const { symlinkSync } = await import("node:fs");
    symlinkSync(elsewhere, join(old, "bin", "linked"));
    expect((await disableOldLoginItem({ bin: join(old, "bin", "linked"), file: "x" }, old, { run, verify: () => true })).ok).toBe(false);
    // In the bin folder but not signed as the old engine's: refused.
    const inBin = join(old, "bin", "old-engine");
    writeFileSync(inBin, "#!/bin/sh\n");
    chmodSync(inBin, 0o755);
    expect(await disableOldLoginItem({ bin: inBin, file: "x" }, old, { run, verify: () => false })).toMatchObject({ ok: false });
    expect(ran).toEqual([]);
    // Signed and in place: it runs, by its real path.
    expect(await disableOldLoginItem({ bin: inBin, file: "x" }, old, { run, verify: () => true })).toEqual({ ok: true });
    expect(ran).toEqual([realpathSync(inBin)]);
    // The places: the old home's bin folder, and on macOS the installed old app's Contents.
    expect(oldBinaryPlaces(old, "linux")).toEqual([join(realpathSync(old), "bin")]);
    expect(oldBinaryPlaces(old, "darwin")[1]).toBe(join(...OLD_APP_BUNDLE_DIR, "Contents"));
    expect(oldEngineRequirement("ABCDE12345")).toBe('anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"');
  });
  darwinTest("macOS: an unsigned program in the old home's bin folder fails the real signature check", async () => {
    const user = temp("moss-old-login-");
    const old = join(user, OLD_INSTALL_HOME_DIR);
    mkdirSync(join(old, "bin"), { recursive: true });
    const inBin = join(old, "bin", "old-engine");
    writeFileSync(inBin, "#!/bin/sh\n");
    chmodSync(inBin, 0o755);
    const ran: string[] = [];
    const r = await disableOldLoginItem({ bin: inBin, file: "x" }, old, { platform: "darwin", run: async (b) => { ran.push(b); return { code: 0, out: "" }; } });
    expect(r.ok).toBe(false);
    expect(ran).toEqual([]);
  });
});
