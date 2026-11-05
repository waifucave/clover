// Small, pure number helpers shared by every check.

export interface Summary {
  n: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

/** Nearest-rank percentile of a list (p in 0..100); NaN for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export function summarize(values: readonly number[]): Summary {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { n: 0, min: Number.NaN, p50: Number.NaN, p95: Number.NaN, max: Number.NaN, mean: Number.NaN };
  const sum = finite.reduce((a, b) => a + b, 0);
  return {
    n: finite.length,
    min: Math.min(...finite),
    p50: percentile(finite, 50),
    p95: percentile(finite, 95),
    max: Math.max(...finite),
    mean: sum / finite.length,
  };
}

/** Round for reports: numbers to `digits` decimals, recursively through arrays and plain objects. */
export function rounded<T>(value: T, digits = 2): T {
  const f = 10 ** digits;
  const walk = (v: unknown): unknown => {
    if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * f) / f : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** Events per second between two counter readings. */
export function rate(n0: number, t0: number, n1: number, t1: number): number {
  const dt = (t1 - t0) / 1000;
  return dt > 0 ? (n1 - n0) / dt : Number.NaN;
}

export function mib(bytes: number): number {
  return bytes / (1024 * 1024);
}

/** `ms` as a promise. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Race a promise against a timeout; the timeout rejects with an Error naming `what`. */
export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Poll `probe` every `everyMs` until it returns a value (not undefined) or `ms` passes; undefined on timeout. */
export async function waitFor<T>(probe: () => Promise<T | undefined> | T | undefined, ms: number, everyMs = 25): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await probe();
      if (v !== undefined) return v;
    } catch {
      // keep polling
    }
    if (Date.now() >= end) return undefined;
    await sleep(everyMs);
  }
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
