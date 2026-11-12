// What crosses between the main process and the windows, counted by channel, and what each process costs, said in the app's
// own log every few seconds. For a test-marked or dev run only (`CLOVER_IPC_STATS=1`): the acceptance run reads it to hold
// an idle app to a budget, and a person chasing a hot idle app reads it to see which channel never stops. Counts only: no
// payload, no plugin id, no text ever goes in the line.

/** The counts of one window of time: messages the windows sent main (`in`, by IPC channel) and main sent them (`out`, by message type). */
export interface IpcWindow {
  seconds: number;
  in: ReadonlyMap<string, number>;
  out: ReadonlyMap<string, number>;
}

export class IpcStats {
  private inCounts = new Map<string, number>();
  private outCounts = new Map<string, number>();

  /** A window sent main one message on `channel`. */
  received(channel: string): void {
    this.inCounts.set(channel, (this.inCounts.get(channel) ?? 0) + 1);
  }

  /** Main sent a window one message of `type`. */
  sent(type: string): void {
    this.outCounts.set(type, (this.outCounts.get(type) ?? 0) + 1);
  }

  /** The counts since the last take, and a fresh start. */
  take(seconds: number): IpcWindow {
    const w = { seconds, in: this.inCounts, out: this.outCounts };
    this.inCounts = new Map();
    this.outCounts = new Map();
    return w;
  }
}

const total = (m: ReadonlyMap<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);
const top = (m: ReadonlyMap<string, number>, n = 6): string =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k.replace(/^clover:/, "")} ${v}`).join(", ");

/** One process's share of a core, as `app.getAppMetrics()` gives it. */
export interface ProcessCpu { type: string; percent: number }

/** The log line: `ipc: 5 s in 12/s (props 40, size 20) out 3/s (props 15) cpu Browser 4.1% Tab 2.0% Tab 1.2% GPU 0.3%`.
 *  The words "ipc: " and the shape are what the acceptance row parses (`parseIpcLine`); keep the two together. */
export function ipcLine(w: IpcWindow, cpu: readonly ProcessCpu[]): string {
  const rate = (n: number) => (n / w.seconds).toFixed(1);
  const inN = total(w.in);
  const outN = total(w.out);
  const procs = cpu.map((p) => `${p.type} ${p.percent.toFixed(1)}%`).join(" ");
  return `ipc: ${w.seconds} s in ${rate(inN)}/s (${top(w.in)}) out ${rate(outN)}/s (${top(w.out)}) cpu ${procs}`;
}

/** Counts every message and says each window's line (`every` ms) while the app runs; the stop function ends it. */
export function startIpcStats(stats: IpcStats, cpu: () => ProcessCpu[], log: (line: string) => void, every = 5_000, setEvery: (fn: () => void, ms: number) => () => void = (fn, ms) => { const t = setInterval(fn, ms); return () => clearInterval(t); }): () => void {
  // The first reading only starts the CPU meter (it covers the time since the app began).
  cpu();
  stats.take(every / 1000);
  return setEvery(() => log(ipcLine(stats.take(every / 1000), cpu())), every);
}

/** The numbers a line carries. */
export interface ParsedIpcLine { seconds: number; inPerSecond: number; outPerSecond: number; cpu: { type: string; percent: number }[] }

/** Reads a line `ipcLine` made (undefined for any other). */
export function parseIpcLine(line: string): ParsedIpcLine | undefined {
  const m = /ipc: (\d+(?:\.\d+)?) s in ([\d.]+)\/s \(.*?\) out ([\d.]+)\/s \(.*?\) cpu(.*)$/.exec(line);
  if (m === null) return undefined;
  const cpu = [...m[4]!.matchAll(/(\S+) ([\d.]+)%/g)].map((c) => ({ type: c[1]!, percent: Number(c[2]) }));
  return { seconds: Number(m[1]), inPerSecond: Number(m[2]), outPerSecond: Number(m[3]), cpu };
}

/** Whether the counter runs: asked for with `CLOVER_IPC_STATS=1`, and only in an unpackaged run or a test-marked build. */
export function ipcStatsOn(input: { env: Readonly<Record<string, string | undefined>>; packaged: boolean; testBuild: boolean }): boolean {
  return input.env.CLOVER_IPC_STATS === "1" && (!input.packaged || input.testBuild);
}
