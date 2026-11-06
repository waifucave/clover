// A hunk's lines as side-by-side rows: context on both sides; a run of removals and the run of
// additions after it pair up row by row, the longer run leaving the other side empty.
import type { DiffLine } from "./types";

export interface SplitRow {
  left?: DiffLine;
  right?: DiffLine;
}

export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === "del") dels.push(lines[i++]!);
    while (i < lines.length && lines[i]!.kind === "add") adds.push(lines[i++]!);
    const count = Math.max(dels.length, adds.length);
    for (let k = 0; k < count; k++) rows.push({ left: dels[k], right: adds[k] });
  }
  return rows;
}
