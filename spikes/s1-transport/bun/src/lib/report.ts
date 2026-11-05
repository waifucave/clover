// Shared helpers for every S1 check: timing, percentiles, and one result line per check.
//
// Each check prints exactly one line `S1RESULT <json>` on stdout. On GitHub Actions it also
// prints a `::notice title=<check>::<json>` annotation, which the public check-runs API serves
// without auth (the brief's fallback for reading CI results).

export const now = (): number => Number(process.hrtime.bigint()) / 1e6; // ms, monotonic

export function summary(samplesMs: number[]): Record<string, number> {
  const s = [...samplesMs].sort((a, b) => a - b);
  const q = (p: number): number => {
    if (s.length === 0) return Number.NaN;
    const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
    return round(s[i]!);
  };
  const mean = s.reduce((a, b) => a + b, 0) / Math.max(1, s.length);
  return { n: s.length, p50: q(50), p90: q(90), p99: q(99), max: q(100), mean: round(mean) };
}

export function round(x: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function mbps(bytes: number, ms: number): number {
  // megabytes (10^6) per second
  return round(bytes / 1e6 / (ms / 1000), 1);
}

export function platformTag(): string {
  return `${process.platform}-${process.arch}`;
}

export function isCompiled(): boolean {
  // `bun build --compile` binaries run from a virtual /$bunfs/ (or B:/~BUN/ on Windows) root.
  const main = (typeof Bun !== "undefined" && Bun.main) || "";
  return main.includes("$bunfs") || main.includes("~BUN");
}

export function emit(check: string, result: Record<string, unknown>): void {
  const line = JSON.stringify({
    check,
    platform: platformTag(),
    runtime: typeof Bun !== "undefined" ? `bun-${Bun.version}` : `node-${process.version}`,
    compiled: isCompiled(),
    ...result,
  });
  console.log(`S1RESULT ${line}`);
  if (process.env.GITHUB_ACTIONS === "true") {
    // Annotations must stay on one line; JSON already is.
    console.log(`::notice title=${check} ${platformTag()}${isCompiled() ? " compiled" : ""}::${line}`);
  }
}

export function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`timeout after ${ms} ms: ${what}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t);
  }
}
