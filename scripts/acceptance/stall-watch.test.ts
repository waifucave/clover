import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processTree, runnerState, stallReportsDone, watchAppStall, watchPingLines } from "./stall-watch";

test("an app whose target list never comes back is reported once, with a report file; one that answers is not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stall-watch-"));
  try {
    const said: string[] = [];
    let alive = true;
    let asks = 0;
    // A pid no process has: the sample can't run, which the report must survive.
    const stopStalled = watchAppStall({ name: "stalled", pid: 2 ** 22 + 7, port: 1, logs: dir, say: (l) => said.push(l), alive: () => alive, ask: () => (asks++ === 0 ? Promise.resolve() : new Promise(() => undefined)) });
    const stopFine = watchAppStall({ name: "fine", pid: 2 ** 22 + 8, port: 2, logs: dir, say: (l) => said.push(l), alive: () => alive, ask: async () => undefined });
    await Bun.sleep(6_500);
    alive = false;
    stopStalled();
    stopFine();
    await stallReportsDone();
    expect(said.filter((l) => l.includes("stalled") && l.startsWith("STALL:"))).toHaveLength(1);
    expect(said.some((l) => l.includes("fine"))).toBe(false);
    expect(readdirSync(dir).filter((f) => f.startsWith("stall-stalled-") && f.endsWith("-1.txt"))).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("the machine's state and a process tree read without throwing", () => {
  expect(runnerState()).toContain("loadavg");
  expect(typeof processTree(process.pid)).toBe("string");
});

test("the daemon's line about an app not answering app.ping looks at each running app, once per line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stall-ping-"));
  try {
    const said: string[] = [];
    writeFileSync(join(dir, "daemon-1.log"), "[moss] app connection 2 counts as user\n");
    const stop = watchPingLines({ logs: dir, say: (l) => said.push(l), apps: () => [{ name: "app", pid: 2 ** 22 + 9, alive: () => true }, { name: "gone-app", pid: 2 ** 22 + 10, alive: () => false }] });
    await Bun.sleep(700);
    expect(said).toEqual([]);
    appendFileSync(join(dir, "daemon-1.log"), "[moss] the app (connection 2) has not answered app.ping for 5003 ms\n");
    await Bun.sleep(1_200);
    stop();
    await stallReportsDone();
    expect(said.filter((l) => l.startsWith("STALL:") && l.includes("5003 ms") && l.includes("app (pid"))).toHaveLength(1);
    expect(readdirSync(dir).filter((f) => f.startsWith("stall-ping-1-app-"))).not.toHaveLength(0);
    expect(readdirSync(dir).some((f) => f.includes("gone-app"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
