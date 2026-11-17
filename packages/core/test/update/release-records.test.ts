// The apps' records under a temp home: a record whose path vanished is dropped, a forged or damaged one is ignored, the
// host comes from the newest app that carries it, the hello's judgement (an app that names no release is behind), and the
// copy policy (a path no app recorded is never taken; a real unsigned file fails the macOS check).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../../src/contracts/fakes/clock";
import { darwinTest } from "../helpers/darwin-only";
import { codesignCheck, copyAcceptable, engineCopyRequirement, type CopyPolicy } from "../../src/update/engine-copy";
import { judgeHello, NO_RELEASE } from "../../src/update/release-door";
import { appRecordPath, EngineReleaseHome, MAX_RECORD_BYTES } from "../../src/update/release-home";

const root = mkdtempSync(join(tmpdir(), "moss-rl-rec-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const home = join(root, `h${n++}`);
  mkdirSync(home, { recursive: true });
  const clock = new FakeClock();
  return { home, clock, h: new EngineReleaseHome({ home, engine: "1.0.0", clock, place: () => {} }) };
};
const app = (name: string): string => { const p = join(root, name); mkdirSync(p, { recursive: true }); return p; };
const carries = { engine: true, host: true };

describe("records", () => {
  test("a record whose path vanished is not listed, and its file goes only after it stayed missing past the grace", () => {
    const { home, clock, h } = fresh();
    const code = app("code-app");
    h.record({ program: "code", bundlePath: code, release: "1.0.0", carries });
    expect(h.apps().map((a) => a.program)).toEqual(["code"]);
    rmSync(code, { recursive: true });
    expect(h.apps()).toEqual([]);
    expect(h.hostSource()).toBeUndefined();
    // Not deleted on the read that found it missing: an app being updated has no bundle for a moment.
    expect(existsSync(appRecordPath(home, "code"))).toBe(true);
    clock.advance(29_000);
    expect(h.apps()).toEqual([]);
    expect(existsSync(appRecordPath(home, "code"))).toBe(true);
    clock.advance(2_000);
    expect(h.apps()).toEqual([]);
    expect(existsSync(appRecordPath(home, "code"))).toBe(false);
  });

  test("an app whose bundle comes back within the grace keeps its record, and the miss is forgotten", () => {
    const { home, clock, h } = fresh();
    const code = app("code-app2");
    h.record({ program: "code", bundlePath: code, release: "1.0.0", carries });
    rmSync(code, { recursive: true });
    expect(h.apps()).toEqual([]);
    clock.advance(20_000);
    mkdirSync(code, { recursive: true });
    expect(h.apps().map((a) => a.program)).toEqual(["code"]);
    rmSync(code, { recursive: true });
    clock.advance(20_000);
    expect(h.apps()).toEqual([]);
    expect(existsSync(appRecordPath(home, "code"))).toBe(true);
  });

  test("the host comes from the newest app that carries it; a tie goes to the later record", () => {
    const { clock, h } = fresh();
    h.record({ program: "moss", bundlePath: app("m1"), release: "1.0.0", carries });
    clock.advance(10);
    h.record({ program: "code", bundlePath: app("c1"), release: "1.0.0", carries });
    expect(h.hostSource()?.program).toBe("code");
    h.record({ program: "moss", bundlePath: app("m1"), release: "1.1.0", carries });
    expect(h.hostSource()?.program).toBe("moss");
    h.record({ program: "host", bundlePath: app("hh"), release: "1.2.0", carries: { engine: false, host: false } });
    expect(h.hostSource()?.program).toBe("moss");
  });

  test("a record that isn't whole is ignored: too big, not JSON, another program's name, a link, an unknown file name", () => {
    const { home, h } = fresh();
    mkdirSync(join(home, "apps"));
    const good = { record: 1, program: "code", bundlePath: app("g"), release: "1.0.0", carries, seenAt: 1 };
    writeFileSync(appRecordPath(home, "code"), JSON.stringify({ ...good, pad: "x".repeat(MAX_RECORD_BYTES) }));
    writeFileSync(appRecordPath(home, "moss"), "not json");
    writeFileSync(appRecordPath(home, "host"), JSON.stringify({ ...good, program: "code" })); // host.json naming code
    writeFileSync(join(home, "apps", "other.json"), JSON.stringify(good));
    expect(h.apps()).toEqual([]);
    // A record that is a link to a good file elsewhere isn't read through.
    const elsewhere = join(root, `elsewhere${n}.json`);
    writeFileSync(elsewhere, JSON.stringify(good));
    rmSync(appRecordPath(home, "code"));
    symlinkSync(elsewhere, appRecordPath(home, "code"));
    expect(h.apps()).toEqual([]);
  });

  test("a record can't name a relative path", () => {
    const { h } = fresh();
    expect(() => h.record({ program: "code", bundlePath: "../escape", release: "1.0.0", carries })).toThrow();
  });
});

describe("the hello's judgement", () => {
  const { h } = fresh();
  test("an app that names no release is behind, once enforcement is on; other roles are not judged", () => {
    expect(judgeHello(h, { role: "app" }, true)).toMatchObject({ kind: "refused", refusal: { standing: "behind", client: NO_RELEASE, needs: "1.0.0" } });
    expect(judgeHello(h, { role: "cli" }, true)).toEqual({ kind: "unjudged" });
    expect(judgeHello(h, { role: "app" }, false)).toEqual({ kind: "unjudged" });
  });
  test("same is served, behind is refused with what it needs, ahead gets the door", () => {
    expect(judgeHello(h, { role: "app", release: "1.0.0" }, true)).toEqual({ kind: "served", release: { standing: "same", engine: "1.0.0" } });
    expect(judgeHello(h, { role: "app", release: "0.9.9" }, true)).toMatchObject({ kind: "refused", refusal: { client: "0.9.9", needs: "1.0.0" } });
    expect(judgeHello(h, { role: "app", release: "1.0.1-rc.10" }, true)).toEqual({ kind: "door", release: { standing: "ahead", engine: "1.0.0" } });
    expect(judgeHello(h, { role: "app", release: "1.0.0-rc.9" }, true)).toMatchObject({ kind: "refused" });
    expect(judgeHello(h, { role: "cli", release: "2.0.0" }, true)).toMatchObject({ kind: "door" });
  });
});

describe("which paths the engine takes a copy or a host from", () => {
  const policy = (records: ReturnType<EngineReleaseHome["apps"]>, platform: NodeJS.Platform, check?: CopyPolicy["check"]): CopyPolicy => ({ platform, profile: "dist", developerId: true, records: () => records, ...(check ? { check } : {}) });
  const rec = (bundlePath: string) => ({ record: 1 as const, program: "code" as const, bundlePath, release: "1.0.0", carries, seenAt: 1 });
  test("a path no app recorded, a path that isn't there and a relative one are refused on every OS", () => {
    const p = app("recorded");
    expect(copyAcceptable(p, "engine", policy([rec(p)], "linux"))).toEqual({ ok: true });
    expect(copyAcceptable(app("unrecorded"), "engine", policy([rec(p)], "linux"))).toMatchObject({ ok: false, reason: "no app recorded that path" });
    expect(copyAcceptable(join(root, "gone"), "engine", policy([rec(join(root, "gone"))], "win32"))).toMatchObject({ ok: false });
    expect(copyAcceptable("relative/app", "host", policy([rec("relative/app")], "linux"))).toMatchObject({ ok: false });
  });
  test("macOS: the host's bundle is checked against the products' identifiers and team; unsigned fails", () => {
    const p = app("host-app");
    const seen: string[] = [];
    expect(copyAcceptable(p, "host", policy([rec(p)], "darwin", (path, r) => { seen.push(r); return false; }))).toMatchObject({ ok: false, reason: "its code signature isn't MOSS's" });
    expect(seen[0]).toContain('identifier "com.waifucave.moss"');
    expect(seen[0]).toContain('identifier "com.waifucave.moss.code"');
    expect(copyAcceptable(p, "host", policy([rec(p)], "darwin", () => true))).toEqual({ ok: true });
  });
  darwinTest("macOS: codesign itself refuses an unsigned file (a real check on a temp file)", () => {
    const f = join(root, "unsigned-core");
    writeFileSync(f, "#!/bin/sh\n");
    expect(codesignCheck(f, engineCopyRequirement("dist", true))).toBe(false);
    expect(codesignCheck(join(root, "no-such-file"), engineCopyRequirement("dev", false))).toBe(false);
  });
});
