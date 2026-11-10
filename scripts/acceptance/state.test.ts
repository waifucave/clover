import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISTRUST, keepStateProblem, readState, settingsWithFake, socketPathProblem, statePaths, writeState, type KeptState } from "./state";

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
