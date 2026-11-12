import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISTRUST, OLD_HALF_STATE_STEPS, keepStateProblem, oldHalfRow, readState, settingsWithFake, socketPathProblem, statePaths, writeState, type KeptState } from "./state";

const dirs: string[] = [];
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "acc-state-"));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const good: KeptState = { v: 1, made: "abc123", target: "source", service: "com.waifucave.clover.core.test.acceptance-1234", key: "sk-ant-acceptance-dummy-00", session: "b_alpha", pluginId: "acceptance-echo", needsYou: false };
/** A state dir as a --keep-state run leaves it. */
function stateDir(s: unknown = good): string {
  const d = temp();
  const p = statePaths(d);
  mkdirSync(p.home, { recursive: true });
  mkdirSync(p.user, { recursive: true });
  mkdirSync(join(d, "kc"), { recursive: true });
  writeFileSync(p.keychain, "x");
  writeFileSync(join(d, "state.json"), JSON.stringify(s));
  return d;
}

describe("the kept state", () => {
  test("round-trips, the file the run's own (0600)", () => {
    const d = stateDir();
    writeState(d, good);
    expect(readState(d)).toEqual(good);
    expect(statSync(join(d, "state.json")).mode & 0o777).toBe(0o600);
  });

  test("keeps the old build's Always rule, or why there is none, and refuses one of the wrong shape", () => {
    const d = stateDir();
    writeState(d, { ...good, always: { tool: "mcp__acceptance-echo-echo__Echo" } });
    expect(readState(d).always).toEqual({ tool: "mcp__acceptance-echo-echo__Echo" });
    writeState(d, { ...good, alwaysMissing: "the Echo call raised no card on the old build" });
    expect(readState(d).alwaysMissing).toContain("no card");
    expect(() => readState(stateDir({ ...good, always: "yes" } as never))).toThrow(/always/);
  });

  test("refuses a service that isn't a test one, a key that isn't the dummy, a missing keychain file", () => {
    expect(() => readState(stateDir({ ...good, service: "com.waifucave.clover.core" }))).toThrow(/test service/);
    expect(() => readState(stateDir({ ...good, key: "sk-ant-real" }))).toThrow(/dummy/);
    const d = stateDir();
    rmSync(statePaths(d).keychain);
    expect(() => readState(d)).toThrow(/lacks/);
    expect(() => readState(temp())).toThrow(/isn't there/);
  });

  test("--keep-state takes a new or empty dir only", () => {
    const d = temp();
    expect(keepStateProblem(join(d, "new"))).toBeUndefined();
    expect(keepStateProblem(d)).toBeUndefined();
    writeFileSync(join(d, "f"), "");
    expect(keepStateProblem(d)).toMatch(/isn't empty/);
  });

  test("a home whose socket path is too long is named", () => {
    expect(socketPathProblem("/tmp/h")).toBeUndefined();
    expect(socketPathProblem(`/tmp/${"x".repeat(120)}`)).toMatch(/Unix socket path/);
  });
});

describe("the settings an upgrade starts from", () => {
  test("a fresh home gets only the fake's endpoint", () => {
    expect(JSON.parse(settingsWithFake(undefined, "http://127.0.0.1:1"))).toEqual({ schemaVersion: 1, providers: { anthropic: { baseUrl: "http://127.0.0.1:1" } } });
  });
  test("an earlier build's settings are kept; only the endpoint moves", () => {
    const old = JSON.stringify({ schemaVersion: 1, theme: "dark", providers: { anthropic: { baseUrl: "http://127.0.0.1:1", extra: 1 }, openai: { x: 2 } } });
    expect(JSON.parse(settingsWithFake(old, "http://127.0.0.1:2"))).toEqual({ schemaVersion: 1, theme: "dark", providers: { anthropic: { baseUrl: "http://127.0.0.1:2", extra: 1 }, openai: { x: 2 } } });
  });
  test("a settings file that isn't an object throws", () => {
    expect(() => settingsWithFake("[]", "u")).toThrow(/object/);
  });
});

test("the distrust lines the upgrade fails on", () => {
  expect(DISTRUST.test("[plugins] plugins: registry.json was changed outside Clover, so it isn't trusted; plugins ask for their OK again")).toBe(true);
  expect(DISTRUST.test("the device registry belongs to another device key")).toBe(true);
  expect(DISTRUST.test("[plugins] bundled: alpha, clover")).toBe(false);
});

describe("the upgrade's old half", () => {
  test("a FAIL in a step the old build can't have reads not asserted on the old build; the try table's label follows", () => {
    const row = oldHalfRow({ n: 26, name: "window: a third-party character renderer (the SDK's picture-swap example) installed", status: "FAIL", detail: "its stage: not within 60 s" });
    expect(row.status).toBe("BLOCKED");
    expect(row.detail).toBe("not asserted on the old build (a feature of a newer build): its stage: not within 60 s");
    expect(row.n).toBe(26);
  });

  test("a FAIL in a step whose state the upgrade reads stays a FAIL; PASS and BLOCKED rows are unchanged", () => {
    for (const name of OLD_HALF_STATE_STEPS) expect(oldHalfRow({ name: `${name} (and more)`, status: "FAIL", detail: "x" }).status).toBe("FAIL");
    const pass = { name: "window: the model picker lists models and a pick takes", status: "PASS", detail: "ok" };
    expect(oldHalfRow(pass)).toBe(pass);
    const blocked = { name: "window: the model picker lists models and a pick takes", status: "BLOCKED", detail: "not reached" };
    expect(oldHalfRow(blocked)).toBe(blocked);
  });

  test("every state step names a step of the full run (a renamed step can't silently drop out)", () => {
    // The step table lives in steps.ts; run.ts and the step modules hold the rest of the names.
    const run = ["run.ts", "steps.ts"].map((f) => readFileSync(join(import.meta.dir, f), "utf8")).join("\n");
    for (const name of OLD_HALF_STATE_STEPS) expect(run.includes(`"${name}`)).toBe(true);
  });
});
