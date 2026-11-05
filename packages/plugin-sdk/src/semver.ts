// Semver versions and ranges, for `version` and `engines.clover` (spec §5.1 "Formats", §5.9). Self-contained, so the
// SDK runs the same in the daemon, the CLI and the app. Ranges take npm's grammar: `1.2.3`, `=`, `<`, `<=`, `>`, `>=`,
// `^`, `~`, x-ranges (`1.x`, `1.2.*`, `*`), hyphen ranges (`1.2.3 - 2.0.0`), spaces for "and" and `||` for "or". A
// prerelease satisfies a range only if a comparator of the same major.minor.patch names a prerelease too.
import { SEMVER_RE } from "@waifucave/clover-protocol";

export interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
}

export function parseVersion(text: string): Version | null {
  const m = SEMVER_RE.exec(text.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
  };
}

export function isVersion(text: string): boolean {
  return parseVersion(text) !== null;
}

function comparePre(a: (string | number)[], b: (string | number)[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Semver precedence: -1, 0 or 1. Build metadata is ignored. */
export function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePre(a.prerelease, b.prerelease);
}

type Op = "<" | "<=" | ">" | ">=" | "=";
interface Comparator { op: Op; v: Version }
/** A range: alternatives (`||`), each a set of comparators that must all hold. */
export type Range = Comparator[][];

const PARTIAL = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface Partial { major?: number; minor?: number; patch?: number; pre: (string | number)[] }

function parsePartial(text: string): Partial | null {
  if (text === "" || text === "*" || text === "x" || text === "X") return { pre: [] };
  const m = PARTIAL.exec(text);
  if (!m) return null;
  const num = (s: string | undefined) => (s === undefined || /^[xX*]$/.test(s) ? undefined : Number(s));
  const major = num(m[1]);
  const minor = major === undefined ? undefined : num(m[2]);
  const patch = minor === undefined ? undefined : num(m[3]);
  const pre = m[4] && patch !== undefined ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { major, minor, patch, pre };
}

const v = (major: number, minor: number, patch: number, pre: (string | number)[] = []): Version => ({ major, minor, patch, prerelease: pre });
const ZERO_PRE: (string | number)[] = [0];

/** The comparators one range term stands for. */
function desugar(op: string, p: Partial): Comparator[] | null {
  const { major, minor, patch, pre } = p;
  const full = major !== undefined && minor !== undefined && patch !== undefined;
  switch (op) {
    case "":
    case "=":
      if (major === undefined) return [{ op: ">=", v: v(0, 0, 0) }];
      if (minor === undefined) return [{ op: ">=", v: v(major, 0, 0) }, { op: "<", v: v(major + 1, 0, 0, ZERO_PRE) }];
      if (patch === undefined) return [{ op: ">=", v: v(major, minor, 0) }, { op: "<", v: v(major, minor + 1, 0, ZERO_PRE) }];
      return [{ op: "=", v: v(major, minor, patch, pre) }];
    case "^": {
      if (major === undefined) return [{ op: ">=", v: v(0, 0, 0) }];
      const lo = v(major, minor ?? 0, patch ?? 0, full ? pre : []);
      if (major > 0 || minor === undefined) return [{ op: ">=", v: lo }, { op: "<", v: v(major + 1, 0, 0, ZERO_PRE) }];
      if (minor > 0 || patch === undefined) return [{ op: ">=", v: lo }, { op: "<", v: v(0, minor + 1, 0, ZERO_PRE) }];
      return [{ op: ">=", v: lo }, { op: "<", v: v(0, 0, patch + 1, ZERO_PRE) }];
    }
    case "~": {
      if (major === undefined) return [{ op: ">=", v: v(0, 0, 0) }];
      const lo = v(major, minor ?? 0, patch ?? 0, full ? pre : []);
      if (minor === undefined) return [{ op: ">=", v: lo }, { op: "<", v: v(major + 1, 0, 0, ZERO_PRE) }];
      return [{ op: ">=", v: lo }, { op: "<", v: v(major, minor + 1, 0, ZERO_PRE) }];
    }
    case ">":
      if (major === undefined) return [{ op: "<", v: v(0, 0, 0, ZERO_PRE) }]; // nothing
      if (minor === undefined) return [{ op: ">=", v: v(major + 1, 0, 0) }];
      if (patch === undefined) return [{ op: ">=", v: v(major, minor + 1, 0) }];
      return [{ op: ">", v: v(major, minor, patch, pre) }];
    case ">=":
      return [{ op: ">=", v: v(major ?? 0, minor ?? 0, patch ?? 0, full ? pre : []) }];
    case "<":
      if (major === undefined) return [{ op: "<", v: v(0, 0, 0, ZERO_PRE) }];
      return [{ op: "<", v: v(major, minor ?? 0, patch ?? 0, full ? pre : ZERO_PRE) }];
    case "<=":
      if (major === undefined) return [{ op: ">=", v: v(0, 0, 0) }];
      if (minor === undefined) return [{ op: "<", v: v(major + 1, 0, 0, ZERO_PRE) }];
      if (patch === undefined) return [{ op: "<", v: v(major, minor + 1, 0, ZERO_PRE) }];
      return [{ op: "<=", v: v(major, minor, patch, pre) }];
    default:
      return null;
  }
}

/** Parses a range; null when it isn't one. */
export function parseRange(text: string): Range | null {
  const alternatives = text.trim().split("||");
  const out: Range = [];
  for (const alt of alternatives) {
    const s = alt.trim().replace(/(<=|>=|<|>|=|\^|~)\s+/g, "$1");
    const set: Comparator[] = [];
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(s);
    if (hyphen) {
      const lo = parsePartial(hyphen[1]!);
      const hi = parsePartial(hyphen[2]!);
      if (!lo || !hi) return null;
      const a = desugar(">=", lo);
      const b = desugar("<=", hi);
      if (!a || !b) return null;
      set.push(...a, ...b);
    } else {
      for (const term of s === "" ? [""] : s.split(/\s+/)) {
        const m = /^(<=|>=|<|>|=|\^|~)?(.*)$/.exec(term)!;
        const p = parsePartial(m[2]!);
        if (!p) return null;
        const cs = desugar(m[1] ?? "", p);
        if (!cs) return null;
        set.push(...cs);
      }
    }
    out.push(set);
  }
  return out;
}

export function isRange(text: string): boolean {
  return parseRange(text) !== null;
}

function holds(c: Comparator, x: Version): boolean {
  const d = compareVersions(x, c.v);
  switch (c.op) {
    case "<": return d < 0;
    case "<=": return d <= 0;
    case ">": return d > 0;
    case ">=": return d >= 0;
    case "=": return d === 0;
  }
}

/** True when `version` satisfies `range` (npm's rules, prereleases included). */
export function satisfies(version: string, range: string): boolean {
  const x = parseVersion(version);
  const r = parseRange(range);
  if (!x || !r) return false;
  return r.some((set) => {
    if (!set.every((c) => holds(c, x))) return false;
    if (x.prerelease.length === 0) return true;
    // A prerelease counts only against a comparator naming a prerelease of the same version (ignoring our own
    // `-0` upper bounds, which only exclude prereleases).
    return set.some((c) => c.v.prerelease.length > 0 && !(c.v.prerelease.length === 1 && c.v.prerelease[0] === 0 && c.op === "<") &&
      c.v.major === x.major && c.v.minor === x.minor && c.v.patch === x.patch);
  });
}
