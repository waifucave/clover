import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppLog, appLogPath } from "../src/main/app-log";

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
});
