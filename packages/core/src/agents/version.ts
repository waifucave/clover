// Version ranges for the agents' tested versions (`AgentQuirks.launch.versions`) and sandbox admissions.

/** Dotted numeric versions: `2026.10.22-27dcf5f` reads as 2026.10.22. */
function parts(v: string): number[] {
  return (/^\d+(?:\.\d+)*/.exec(v.trim())?.[0] ?? "").split(".").filter((x) => x !== "").map(Number);
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** A range of space-separated comparisons (`>=1.4.12 <1.5.0`). */
export function versionSatisfies(version: string, range: string): boolean {
  const v = parts(version);
  if (v.length === 0) return false;
  for (const term of range.trim().split(/\s+/).filter(Boolean)) {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(term);
    if (!m) return false;
    const c = cmp(v, parts(m[2]!));
    const ok = { ">=": c >= 0, "<=": c <= 0, ">": c > 0, "<": c < 0, "=": c === 0 }[m[1] ?? "="];
    if (!ok) return false;
  }
  return true;
}
