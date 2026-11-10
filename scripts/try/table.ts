// The per-step table of a try's packaged acceptance runs (scripts/try/run.sh): one column per run, one row per step,
// from each run's run.out (scripts/acceptance/run.ts's own table, `| n | step | STATUS | detail`). A step the script
// can't drive on a packaged app (BLOCKED, naming the packaged target) reads NOT RUN ON PACKAGED; each reason that
// isn't a PASS is listed once under the table, with the runs it came from.
//
//   scripts/pinned-bun scripts/try/table.ts <acceptance folder> <run folder>...
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface StepRow { n: number; name: string; status: string; detail: string }

/** The rows of run.ts's table in one run's output. */
export function parseRunTable(text: string): StepRow[] {
  const rows: StepRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\|\s*(\d+)\s*\|\s*(.*?)\s*\|\s*(PASS|FAIL|BLOCKED)\s*\|\s*(.*?)\s*\|?\s*$/.exec(line);
    if (m) rows.push({ n: Number(m[1]), name: m[2]!, status: m[3]!, detail: m[4]! });
  }
  return rows;
}

/** A row's status as the try's table shows it. */
export function shownStatus(row: StepRow): string {
  return row.status === "BLOCKED" && /packaged/i.test(row.detail) ? "NOT RUN ON PACKAGED" : row.status;
}

/** The table and the reasons under it, for runs labelled by their folder names. */
export function formatTable(runs: Array<{ label: string; rows: StepRow[] | undefined }>): string {
  const steps = new Map<number, string>();
  for (const r of runs) for (const row of r.rows ?? []) if (!steps.has(row.n)) steps.set(row.n, row.name);
  const ns = [...steps.keys()].sort((a, b) => a - b);
  const cell = (r: { rows: StepRow[] | undefined }, n: number): string => {
    if (r.rows === undefined) return "NO OUTPUT";
    const row = r.rows.find((x) => x.n === n);
    return row === undefined ? "-" : shownStatus(row);
  };
  const header = ["step", ...runs.map((r) => r.label)];
  const body = ns.map((n) => [`${n} ${steps.get(n)!.slice(0, 60)}`, ...runs.map((r) => cell(r, n))]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i]!)).join(" | ")} |`;
  const out = [line(header), `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`, ...body.map(line)];
  const reasons = new Map<string, string[]>();
  for (const r of runs) for (const row of r.rows ?? []) {
    if (row.status === "PASS") continue;
    const key = `${row.n} ${shownStatus(row)}: ${row.detail}`;
    reasons.set(key, [...(reasons.get(key) ?? []), r.label]);
  }
  if (reasons.size > 0) out.push("", "not PASS:", ...[...reasons].map(([k, labels]) => `  step ${k} (${labels.join(", ")})`));
  for (const r of runs) if (r.rows === undefined) out.push(`  ${r.label}: no run.out table (the run didn't finish; see its watchdog.txt)`);
  return out.join("\n");
}

if (import.meta.main) {
  const [folder, ...labels] = process.argv.slice(2);
  if (folder === undefined || labels.length === 0) {
    console.error("usage: scripts/try/table.ts <acceptance folder> <run folder>...");
    process.exit(2);
  }
  console.log(formatTable(labels.map((label) => {
    const file = join(folder, label, "run.out");
    return { label, rows: existsSync(file) ? parseRunTable(readFileSync(file, "utf8")) : undefined };
  })));
}
