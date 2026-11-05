// JSON with comments and trailing commas, as `clover.json` and the other plugin files accept (spec §5.9).
// Comments (`//` to the line's end, `/* … */`) and a comma before `}` or `]` are removed; everything else is JSON.

export type JsoncResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { message: string; line: number; column: number } };

/** Removes comments and trailing commas, keeping every other character's line and column. */
export function stripJsonc(text: string): string {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  // A comma we have seen but not yet written: written if a value follows, dropped if `}` or `]` does.
  let pendingComma: number | null = null;
  const flushComma = () => {
    if (pendingComma !== null) {
      out[pendingComma] = ",";
      pendingComma = null;
    }
  };
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      flushComma();
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out.push(text.slice(i, Math.min(j + 1, n)));
      i = j + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      let j = i;
      while (j < n && text[j] !== "\n") j++;
      out.push(" ".repeat(j - i));
      i = j;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const j = end < 0 ? n : end + 2;
      out.push(text.slice(i, j).replace(/[^\n]/g, " "));
      i = j;
      continue;
    }
    if (c === ",") {
      flushComma();
      pendingComma = out.length;
      out.push(" ");
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      pendingComma = null;
      out.push(c);
      i++;
      continue;
    }
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") flushComma();
    out.push(c);
    i++;
  }
  flushComma();
  return out.join("");
}

function position(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let k = 0; k < Math.min(offset, text.length); k++) {
    if (text[k] === "\n") {
      line++;
      column = 1;
    } else column++;
  }
  return { line, column };
}

/** Parses JSON with comments and trailing commas. */
export function parseJsonc(text: string): JsoncResult {
  const stripped = stripJsonc(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  try {
    return { ok: true, value: JSON.parse(stripped) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const m = /position (\d+)/.exec(message) ?? /at (\d+)/.exec(message);
    const at = m ? position(stripped, Number(m[1])) : { line: 1, column: 1 };
    return { ok: false, error: { message, ...at } };
  }
}
