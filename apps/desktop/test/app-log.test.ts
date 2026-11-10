import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppLog, appLogPath, cleanLogLine } from "../src/main/app-log";

describe("the app's log", () => {
  test("lines go to <home>/logs/app.log, one line each, with the time, in a private file", () => {
    const home = mkdtempSync(join(tmpdir(), "app-log-"));
    const log = new AppLog(appLogPath(home));
    log.write("layer: clover/composer: a layer doesn't call session.send", new Date("2026-11-10T10:00:00Z"));
    log.write("two\nlines");
    const lines = readFileSync(join(home, "logs", "app.log"), "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe("2026-11-10T10:00:00.000Z layer: clover/composer: a layer doesn't call session.send");
    expect(lines[1]).toContain("two lines");
    expect(statSync(join(home, "logs", "app.log")).mode & 0o077).toBe(0);
  });

  test("it is size-capped: past the cap the file moves to app.log.1 and starts again; a long line is cut", () => {
    const home = mkdtempSync(join(tmpdir(), "app-log-"));
    const log = new AppLog(appLogPath(home), 500);
    for (let i = 0; i < 40; i++) log.write(`line ${i} ${"x".repeat(50)}`);
    expect(readdirSync(join(home, "logs")).sort()).toEqual(["app.log", "app.log.1"]);
    expect(statSync(join(home, "logs", "app.log")).size).toBeLessThanOrEqual(500);
    log.write("y".repeat(5000));
    expect(readFileSync(join(home, "logs", "app.log"), "utf8").length).toBeLessThan(700);
  });

  test("an unwritable place never throws", () => {
    expect(() => new AppLog("/dev/null/nope/app.log").write("x")).not.toThrow();
  });

  test("a line keeps no URL query, no token-like run, and an existing log (and its .1) is made private", () => {
    expect(cleanLogLine("web: https://x.example/page?key=sk-ant-abc&token=1 failed")).toBe("web: https://x.example/page failed");
    expect(cleanLogLine(`auth ${"A1b2".repeat(10)} ok`)).toBe("auth [x] ok");
    const home = mkdtempSync(join(tmpdir(), "app-log-"));
    mkdirSync(join(home, "logs"));
    for (const f of ["app.log", "app.log.1"]) { writeFileSync(join(home, "logs", f), "old\n"); chmodSync(join(home, "logs", f), 0o644); }
    new AppLog(appLogPath(home)).write("hello");
    for (const f of ["app.log", "app.log.1"]) expect(statSync(join(home, "logs", f)).mode & 0o077).toBe(0);
  });
});
