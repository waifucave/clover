// A test's reading of a `sandbox.filesystem` deny list the way the agent SDK reads it (`splitDenyPathsByGlobShape`):
// a plain entry denies that path and everything under it; an entry holding `*`, `?` or a real `[...]` class is a glob
// (`*` within a name, `**/` any folders, `?` one letter, `[...]` a class, `[[]` a literal `[`) that denies what it
// matches and everything under it. Names fold case on macOS, as Seatbelt matches them.
export function globToRegex(glob: string, fold: boolean): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "[") {
      if (glob.startsWith("[[]", i)) { out += "\\["; i += 2; continue; }
      const end = glob.indexOf("]", i + 1);
      out += glob.slice(i, end + 1);
      i = end;
    } else if (c === "*") {
      if (glob[i + 1] === "*" && glob[i + 2] === "/") { out += "(.*/)?"; i += 2; }
      else if (glob[i + 1] === "*") { out += ".*"; i += 1; }
      else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.^$+{}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}(/.*)?$`, fold ? "i" : "");
}

const isGlob = (entry: string) => /[*?]/.test(entry) || /\[(?!\[\])/.test(entry.replace(/\[\[\]/g, ""));

/** Whether `path` is denied by `list` (`platform` decides whether names fold). */
export function deniedBy(list: readonly string[], path: string, platform: NodeJS.Platform = process.platform): boolean {
  const fold = platform === "darwin";
  const f = (s: string) => (fold ? s.toLowerCase() : s);
  return list.some((entry) => {
    if (isGlob(entry)) return globToRegex(entry, fold).test(path);
    const literal = entry.replace(/\[\[\]/g, "[");
    return f(path) === f(literal) || f(path).startsWith(`${f(literal)}/`);
  });
}
