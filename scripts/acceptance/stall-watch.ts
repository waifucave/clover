// What the acceptance run measures about its own machine, on a CI runner only (GITHUB_ACTIONS, or MOSS_ACCEPT_DIAGNOSE=1):
//
//   - `watchAppStall`: a headless app's main process, asked every second for its DevTools target list (answered by the
//     browser process's UI thread, which is the thread the app's JavaScript runs on and the one that answers the daemon's
//     `app.ping`). An app whose list does not come back within 2.5 s for two seconds running is STALLED: the run says so
//     on its progress (GitHub stamps each line), writes `stall-<app>-<pid>-<n>.txt` in the kept logs with the machine's
//     state and the app's processes (state, CPU), and takes a `sample` of the app's main process, which shows what its
//     main thread is doing. The same loop times the harness's own timer: a harness that wakes late says "the harness ran
//     late", which means the whole runner was held up, not only the app.
//   - `runnerState`: load, memory pressure, swap and the busiest processes, one block of text.
//
// It exists because a run on a 3-core runner lost its app (the daemon ends an app that doesn't answer `app.ping` for 15 s)
// about one run in three, and nothing kept said whether the app or the runner stopped. Nothing here changes what a row
// does; every command it runs reads state (`ps` names, never arguments or environments).
import { execFile, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadavg } from "node:os";

export const diagnosing = (): boolean => process.env.GITHUB_ACTIONS === "true" || process.env.MOSS_ACCEPT_DIAGNOSE === "1";

const run = (cmd: string, args: string[], timeoutMs = 4_000): string => {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs });
    return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  } catch (err) {
    return `(${cmd} failed: ${err instanceof Error ? err.message : String(err)})`;
  }
};

/** The machine's state now: the time, the load, the memory and swap, and the ten busiest processes (names only). */
export function runnerState(): string {
  const lines = [`time ${new Date().toISOString()}`, `loadavg ${loadavg().map((x) => x.toFixed(2)).join(" ")}`];
  if (process.platform === "darwin") {
    lines.push(`cpus ${run("sysctl", ["-n", "hw.ncpu"])}  memory ${Math.round(Number(run("sysctl", ["-n", "hw.memsize"])) / 2 ** 30)} GiB`);
    lines.push(`swap ${run("sysctl", ["-n", "vm.swapusage"])}`);
    lines.push(`memory pressure level ${run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"])} (1 normal, 2 warning, 4 critical)`);
    lines.push(run("vm_stat", []).split("\n").slice(0, 12).join("\n"));
    lines.push("busiest processes (pid, %cpu, %mem, rss KiB, state, command name):");
    lines.push(run("ps", ["-A", "-r", "-o", "pid=,pcpu=,pmem=,rss=,state=,comm="]).split("\n").slice(0, 10).map((l) => l.trim().replace(/\/[^\s]*\//g, "")).join("\n"));
  }
  return lines.join("\n");
}

/** The process `pid` and everything under it: pid, parent, %cpu, rss, state, elapsed, CPU time, command name. */
export function processTree(pid: number): string {
  const rows = run("ps", ["-A", "-o", "pid=,ppid=,pcpu=,rss=,state=,etime=,time=,comm="]).split("\n").map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 8);
  const under = new Set<number>([pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const c of rows) if (!under.has(Number(c[0])) && under.has(Number(c[1]))) { under.add(Number(c[0])); grew = true; }
  }
  return rows.filter((c) => under.has(Number(c[0]))).map((c) => `${c.slice(0, 7).join(" ")} ${c.slice(7).join(" ").replace(/\/[^\s]*\//g, "")}`).join("\n");
}

/** `sample <pid> <seconds>` into `file` (what the main thread is doing); resolves when it has finished or after 60 s. */
function sampleTo(pid: number, seconds: number, file: string): Promise<void> {
  return new Promise((done) => {
    const finish = (): void => done();
    const first = execFile("/usr/bin/sample", [String(pid), String(seconds), "-file", file], { timeout: 60_000 }, (err) => {
      if (err === null) return finish();
      // Not allowed to look at that process as this user: the runner's own passwordless sudo, if it has one.
      execFile("sudo", ["-n", "/usr/bin/sample", String(pid), String(seconds), "-file", file], { timeout: 60_000 }, () => finish());
    });
    first.on("error", finish);
  });
}

export interface StallOptions {
  /** The app's name in the run (`app`, `ui-app`, ...), its main process and its DevTools port. */
  name: string;
  pid: number;
  port: number;
  /** The kept logs' folder. */
  logs: string;
  /** One progress line. */
  say(line: string): void;
  /** Whether the app's process is still there. */
  alive(): boolean;
  /** How the list is asked for (the real one is a `fetch`); tests give their own. */
  ask?(port: number, timeoutMs: number): Promise<void>;
}

const STALL_AFTER_MS = 2_000;
const ASK_TIMEOUT_MS = 2_500;
const MAX_REPORTS = 4;
/** Reports in flight (a sample takes a few seconds): the run waits for them before it ends. */
const pending = new Set<Promise<void>>();
export const stallReportsDone = async (): Promise<void> => { await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, 70_000))]); };

const defaultAsk = async (port: number, timeoutMs: number): Promise<void> => {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
  await r.text();
};

/** Watches one app until its process goes. Returns a function that stops the watch. */
export function watchAppStall(o: StallOptions): () => void {
  const ask = o.ask ?? defaultAsk;
  let stopped = false;
  let stalledSince: number | undefined;
  let reports = 0;
  let reported = false;
  // An app still starting (its first target list not yet answered) is not stalled: it is a process the machine is still loading.
  let answered = false;
  let lastTick = Date.now();
  const timer = setInterval(() => {
    if (stopped) return;
    if (!o.alive()) { stop(); return; }
    const t0 = Date.now();
    // The harness's own timer: a tick far later than a second means this process was not run for that long.
    if (t0 - lastTick > 2_500) o.say(`STALL: the harness itself ran ${((t0 - lastTick) / 1000).toFixed(1)} s late (its 1 s timer): the whole runner was held up. ${runnerState().split("\n").slice(0, 4).join("; ")}`);
    lastTick = t0;
    void Promise.race([ask(o.port, ASK_TIMEOUT_MS), new Promise<void>((_, no) => setTimeout(() => no(new Error("no answer")), ASK_TIMEOUT_MS + 200).unref?.())]).then(
      () => {
        const took = Date.now() - t0;
        if (took < ASK_TIMEOUT_MS && took < STALL_AFTER_MS) {
          answered = true;
          if (stalledSince !== undefined && reported) o.say(`STALL over: ${o.name} (pid ${o.pid}) answered its target list again, ${((Date.now() - stalledSince) / 1000).toFixed(1)} s after it stopped`);
          stalledSince = undefined;
          reported = false;
          return;
        }
        begin(t0);
      },
      () => begin(t0),
    );
  }, 1_000);
  const stop = (): void => { stopped = true; clearInterval(timer); };
  const begin = (t0: number): void => {
    if (stopped || !o.alive() || !answered) return;
    stalledSince ??= t0;
    if (reported || Date.now() - stalledSince < STALL_AFTER_MS || reports >= MAX_REPORTS) return;
    reported = true;
    reports++;
    const n = reports;
    const base = join(o.logs, `stall-${o.name}-${o.pid}-${n}`);
    const state = runnerState();
    o.say(`STALL: ${o.name} (pid ${o.pid}) has not answered its DevTools target list for ${((Date.now() - stalledSince) / 1000).toFixed(1)} s (report ${base}.txt). ${state.split("\n").slice(0, 4).join("; ")}`);
    mkdirSync(o.logs, { recursive: true });
    writeFileSync(`${base}.txt`, `${state}\n\nthe app's processes (pid ppid %cpu rss state elapsed cputime command):\n${processTree(o.pid)}\n`);
    const job = sampleTo(o.pid, 3, `${base}.sample.txt`).then(() => {
      try { writeFileSync(`${base}.after.txt`, `${runnerState()}\n\nthe app's processes:\n${processTree(o.pid)}\nalive: ${o.alive()}\n`); } catch { /* the folder is gone */ }
    });
    pending.add(job);
    void job.finally(() => pending.delete(job));
  };
  return stop;
}

/** Every 10 s, one line in `<logs>/runner.log`: the time, the load, the memory pressure and the three busiest processes (names only),
 *  so a row that failed at a moment can be read against how busy the machine was then. Returns a function that stops it. */
export function startRunnerLog(logs: string): () => void {
  mkdirSync(logs, { recursive: true });
  const file = join(logs, "runner.log");
  const line = (): void => {
    const busiest = run("ps", ["-A", "-r", "-o", "pcpu=,comm="], 3_000).split("\n").slice(0, 3).map((l) => l.trim().replace(/\/[^\s]*\//g, "")).join(" | ");
    // Free memory and the pages read from disk since boot (a jump in it between two lines: the machine was paging programs in).
    const vm = process.platform === "darwin" ? run("vm_stat", [], 2_000) : "";
    const free = /Pages free:\s+(\d+)/.exec(vm)?.[1];
    const pageSize = Number(/page size of (\d+) bytes/.exec(vm)?.[1] ?? 16384);
    const pageins = /Pageins:\s+(\d+)/.exec(vm)?.[1];
    const memory = free === undefined ? "" : ` free ${Math.round((Number(free) * pageSize) / 2 ** 20)} MiB pageins ${pageins ?? "?"}`;
    const pressure = process.platform === "darwin" ? ` pressure ${run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], 2_000)} swap ${run("sysctl", ["-n", "vm.swapusage"], 2_000).split("  ")[1] ?? "?"}` : "";
    try { appendFileSync(file, `${new Date().toISOString()} load ${loadavg().map((x) => x.toFixed(1)).join(" ")}${memory}${pressure} busiest ${busiest}\n`); } catch { /* the folder is gone */ }
  };
  line();
  const t = setInterval(line, 10_000);
  t.unref?.();
  return () => clearInterval(t);
}

/** The daemon's own word that an app has not answered `app.ping` for a while (packages/core/src/ipc/moss.ts, a third of the way to the 15 s
 *  after which it ends the app): read from the run's daemon logs, and at that moment each running app is looked at (its machine state, its
 *  processes, a `sample` of its main thread), because the app is ended 10 s later. This is the signal the engine itself acts on, so it
 *  catches the stall that the DevTools list (`watchAppStall`) did not (run 44851355486: the daemon ended the app, the list had answered). */
export function watchPingLines(o: { logs: string; apps(): { name: string; pid: number; alive(): boolean }[]; say(line: string): void }): () => void {
  const offsets = new Map<string, number>();
  let n = 0;
  const timer = setInterval(() => {
    let files: string[] = [];
    try { files = readdirSync(o.logs).filter((f) => /^daemon-\d+\.log$/.test(f)); } catch { return; }
    for (const f of files) {
      const file = join(o.logs, f);
      let size = 0;
      try { size = statSync(file).size; } catch { continue; }
      const from = offsets.get(f) ?? 0;
      if (size <= from) { offsets.set(f, size); continue; }
      offsets.set(f, size);
      let text = "";
      try { text = readFileSync(file, "utf8").slice(from); } catch { continue; }
      for (const m of text.matchAll(/the app \(connection (\d+)\) has not answered app\.ping for (\d+) ms/g)) {
        if (n >= MAX_REPORTS) return;
        n++;
        const apps = o.apps().filter((a) => a.alive());
        o.say(`STALL: the daemon (${f}) says the app (connection ${m[1]}) has not answered app.ping for ${m[2]} ms; looking at ${apps.map((a) => `${a.name} (pid ${a.pid})`).join(", ") || "no running app"}. ${runnerState().split("\n").slice(0, 4).join("; ")}`);
        for (const a of apps) {
          const base = join(o.logs, `stall-ping-${n}-${a.name}-${a.pid}`);
          writeFileSync(`${base}.txt`, `${runnerState()}\n\nthe app's processes (pid ppid %cpu rss state elapsed cputime command):\n${processTree(a.pid)}\n`);
          const job = sampleTo(a.pid, 3, `${base}.sample.txt`).then(() => {
            try { writeFileSync(`${base}.after.txt`, `${runnerState()}\n\nthe app's processes:\n${processTree(a.pid)}\nalive: ${a.alive()}\n`); } catch { /* the folder is gone */ }
          });
          pending.add(job);
          void job.finally(() => pending.delete(job));
        }
      }
    }
  }, 500);
  timer.unref?.();
  return () => clearInterval(timer);
}
