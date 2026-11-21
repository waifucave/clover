// What a log gained between two readings, when the log a step reads (`ctx.appLog()`) is TWO files joined: the app's own output,
// then the home's app.log. A step that took the joined text's LENGTH as its mark and later sliced from it read the wrong lines
// once the first file had grown in between: the cut then fell inside the second file, before the mark (try 17, row 70: the
// 214-byte ipc line the app printed during the hold moved the cut back over the island's "island bounds 400x240" line from
// before the pointer came, and the row counted it as a resize under the pointer). Both files only ever grow at their ends, so
// what is new is what the later reading holds more of, line by line.

/** The lines of `after` that `before` did not already hold, in `after`'s order: each distinct line counted, so a line that
 *  both files repeat (the app's own output has no timestamps) is new only for the times it came again. */
export function linesSince(before: string, after: string): string[] {
  const seen = new Map<string, number>();
  for (const l of before.split("\n")) seen.set(l, (seen.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const l of after.split("\n")) {
    const n = seen.get(l) ?? 0;
    if (n > 0) seen.set(l, n - 1);
    else out.push(l);
  }
  return out;
}
