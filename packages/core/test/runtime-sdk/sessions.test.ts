// G-13: the nine standalone session functions address MOSS's store, in the home the caller named
// — and there is NO door here that can be opened without naming one.
//
// The negative half is the point of the module (review F2): with a MOSS brand but no `MOSS_HOME`
// in the environment, the SDK's own resolution lands on `~/.moss` — the user's live daily driver.
// So the test that proves it is not reachable runs with `MOSS_HOME` unset and `HOME` pointed at a
// temp dir: if any door ever resolves a home implicitly again, it resolves THAT one, and the
// assertion sees it. No real home is touched either way.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as wrappers from "../../src/runtime-sdk/sessions";
import { mossSessions } from "../../src/runtime-sdk/sessions";
import { storeProjectsDir } from "../../src/agent/paths";

/** The nine, by name (`clover-sdk/dist/index.d.ts:35`). */
const NINE = [
  "listSessions", "getSessionInfo", "getSessionMessages", "renameSession", "tagSession",
  "deleteSession", "forkSession", "listSubagents", "getSubagentMessages",
] as const;

let home: string;
let elsewhere: string;
let fakeHome: string;
let envBefore: Record<string, string | undefined>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "p8b-sessions-"));
  elsewhere = mkdtempSync(join(tmpdir(), "p8b-notmoss-"));
  fakeHome = mkdtempSync(join(tmpdir(), "p8b-fakehome-"));
  // Pre-rename this set two distinct env keys — the daemon's own home var, and MOSS_HOME (the
  // SDK's brand-derived home); the rename makes them the same key, so it is saved/restored once.
  envBefore = { MOSS_HOME: process.env.MOSS_HOME, MOSS_PROFILE: process.env.MOSS_PROFILE, HOME: process.env.HOME };
});
afterEach(() => {
  for (const [k, v] of Object.entries(envBefore)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const dir of [home, elsewhere, fakeHome]) rmSync(dir, { recursive: true, force: true });
});

/** A transcript where the SDK's own store keeps one: `<store home>/projects/<key>/<id>.jsonl` — the store
 *  home is `storeHomeFor(home)` (WS-21: `<home>/sdk` on a run-home build). */
function seed(root: string, projectKey: string, sessionId: string, text: string): void {
  mkdirSync(join(storeProjectsDir(root), projectKey), { recursive: true });
  writeFileSync(
    join(storeProjectsDir(root), projectKey, `${sessionId}.jsonl`),
    `${JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-11T00:00:00.000Z", text })}\n`,
  );
}

describe("the G-13 wrapper", () => {
  test("mossSessions(home) binds all nine, and NOTHING else is exported", () => {
    const bound = mossSessions(home);
    expect(Object.keys(bound).sort()).toEqual([...NINE].sort());
    for (const name of NINE) expect(typeof bound[name]).toBe("function");
    // THE FENCE: no module-level wrapper survives, so there is no way to call one of the nine
    // through this module without naming a home. `MossSessionOptions` is a type and erases.
    expect(Object.keys(wrappers)).toEqual(["mossSessions"]);
  });

  test("it reads the store home's projects/ (sdk/projects on a run-home build) — in the home that was named", async () => {
    seed(home, "-tmp-alpha", "s_moss", "hello from moss");
    const sessions = mossSessions(home);
    const listed = await sessions.listSessions();
    expect(listed.map((s) => s.sessionId)).toEqual(["s_moss"]);
    expect(listed[0]?.projectKey).toBe("-tmp-alpha");

    expect((await sessions.getSessionInfo("s_moss")).entryCount).toBe(1);
    expect(await sessions.getSessionMessages("s_moss")).toHaveLength(1);
  });

  // THE NEGATIVE (review F2). `MOSS_HOME` unset, `HOME` pointed at a temp dir seeded with a
  // `projects/` tree: an implicit resolution would find `<fakeHome>/.moss`, and every assertion
  // here says it did not. On a real machine the same code path would have read the user's daemon.
  test("no door resolves a home implicitly: MOSS_HOME unset and HOME redirected changes nothing", async () => {
    delete process.env.MOSS_HOME;
    delete process.env.MOSS_PROFILE;
    delete process.env.MOSS_HOME;
    process.env.HOME = fakeHome;
    // What an implicit `~/.moss` resolution WOULD have found.
    seed(join(fakeHome, ".moss"), "-tmp-alpha", "s_would_have_been_the_users", "the daily driver");
    seed(home, "-tmp-alpha", "s_moss", "hello from moss");

    // Every reachable door still needs a home, and answers from THAT home.
    const listed = await mossSessions(home).listSessions();
    expect(listed.map((s) => s.sessionId)).toEqual(["s_moss"]);
    // The "user's home" transcript is invisible through every one of the nine.
    await expect(mossSessions(home).getSessionInfo("s_would_have_been_the_users")).rejects.toThrow();
    // And nothing wrote into it either.
    expect(existsSync(join(storeProjectsDir(join(fakeHome, ".moss")), "-tmp-alpha", "s_moss.jsonl"))).toBe(false);
  });

  // The BRAND half, which the home binding does not subsume: a MOSS-branded call with this
  // environment would read `<elsewhere>`, and it does not.
  //
  // The two session ids here MUST differ (fix wave, 9b T.1): pre-rename `home` seeded one brand's
  // session id and `elsewhere` seeded the OTHER's — two distinct strings that happened to collapse
  // onto the same literal once the generic rename pass ran. With one shared id the collision this
  // test exists to catch (an implicit fall-through to `MOSS_HOME=elsewhere`) is indistinguishable
  // from the passing case, so it silently stopped testing anything.
  test("MOSS_HOME is ignored — the brand decides which product's store this is", async () => {
    seed(home, "-tmp-alpha", "s_this_home", "hello from this home");
    seed(elsewhere, "-tmp-alpha", "s_elsewhere", "hello from elsewhere");
    // Pre-rename this set two distinct env keys — the daemon's own home var, then MOSS_HOME; the
    // rename makes them the same key, so it is written once now — even the env door for OUR OWN
    // brand loses to the argument.
    process.env.MOSS_HOME = elsewhere;

    const listed = await mossSessions(home).listSessions();
    expect(listed.map((s) => s.sessionId)).toEqual(["s_this_home"]);
    await expect(mossSessions(home).getSessionInfo("s_elsewhere")).rejects.toThrow();
  });

  test("a caller's `directory` passes through; `home` is not overridable through the options", async () => {
    seed(home, "-tmp-alpha", "s_moss", "hello");
    // `MossSessionOptions` has no `winterHome`/`brand` member at all, so a caller cannot re-home a
    // bound set by passing one — this is the compile-time half of the fence, asserted at runtime by
    // the fact that an extra key changes nothing.
    const listed = await mossSessions(home).listSessions({ ...({ winterHome: elsewhere } as object) });
    expect(listed.map((s) => s.sessionId)).toEqual(["s_moss"]);
  });
});
