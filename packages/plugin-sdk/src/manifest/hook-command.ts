// How a hook's `command` runs (§5.3), and the one shape it may not take. A hook's stdin is its input as JSON: tool
// results, prompts, text the user pasted, a page a bot fetched. It is data, and nothing may read it as a script.
//
// * With `args`: `command` is a program, run directly with those arguments; no shell is between. Each placeholder
//   (`${plugin}`, `${data}`, `${setting:k}`) fills its whole argument, whatever the value holds.
// * Without `args`: `command` is a shell command line, run as `sh -c <command>`, so the shell's script is the command
//   and its stdin stays the hook's input. A placeholder in it is never spliced into that line: the core passes its value
//   in the environment (`HOOK_PLACEHOLDER_ENV`) and writes a reference to that variable in its place, so a value holding
//   quotes, `$(…)`, backticks or a newline is never parsed.
// * Refused (`hookReadsStdinAsScript`): a command whose program is an interpreter given no script, which would run
//   its stdin (`sh`, `bash -s`, `python3`, `node -`, `env python3`, and each command of a `;`, `&&` or `||` list). A
//   pipe's later commands read the pipe, not the hook's stdin, and are the plugin's own choice.

/** Programs that, given no script, read one from their stdin. */
const STDIN_INTERPRETERS = /^(?:sh|bash|zsh|dash|ksh|mksh|ash|fish|csh|tcsh|busybox|python[0-9.]*|pypy[0-9.]*|node|nodejs|bun|deno|ruby|perl[0-9.]*|php[0-9.]*|lua[0-9.]*|luajit|tclsh[0-9.]*|wish[0-9.]*|osascript|pwsh|powershell|cmd|irb|jshell|Rscript|R|julia|elixir|guile|racket|sbcl|ghci|swift|expect)$/i;

/** Flags that hand an interpreter its script (or a module, or a file) rather than its stdin. */
const SCRIPT_FLAGS = new Set(["-c", "-e", "--eval", "-p", "--print", "-m", "-r", "--require", "-x", "-Command", "-command", "-c:", "-EncodedCommand", "-File", "-file", "/c", "/C", "/k", "/K", "-f", "--file", "--run", "-E"]);
/** Arguments that make an interpreter read its stdin even with others given. */
const STDIN_ARGS = new Set(["-", "-s", "--stdin", "/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"]);
/** Wrappers that run the program after them. */
const WRAPPERS = new Set(["env", "exec", "command", "nohup", "nice", "time", "builtin", "stdbuf", "caffeinate", "arch"]);
/** Subcommands that take a script file (`bun run x.ts`, `deno run x.ts`). */
const RUN_SUBCOMMANDS = new Set(["run", "x", "exec", "eval", "test"]);

const programName = (token: string): string => token.split(/[\\/]/).pop()!.replace(/\.exe$/i, "");

/** Why an argv would run its stdin as a script, or undefined. */
function argvReadsStdin(argv: readonly string[]): string | undefined {
  let i = 0;
  // Past `env`, `exec` and the like, and `NAME=value` assignments, to the program they run.
  while (i < argv.length && (WRAPPERS.has(programName(argv[i]!)) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!) || (i > 0 && WRAPPERS.has(programName(argv[i - 1]!)) && argv[i]!.startsWith("-")))) i++;
  const program = argv[i];
  if (program === undefined) return undefined;
  const name = programName(program);
  if (!STDIN_INTERPRETERS.test(name)) return undefined;
  const rest = argv.slice(i + 1);
  if (rest.some((a) => STDIN_ARGS.has(a))) return `\`${name}\` is told to read its script from stdin`;
  if (rest.some((a) => SCRIPT_FLAGS.has(a) || RUN_SUBCOMMANDS.has(a) || !a.startsWith("-"))) return undefined;
  return `\`${name}\` is given no script, so it would run its stdin, the hook's input, as one`;
}

/** Splits one simple command into words: whitespace outside quotes, the quotes taken off. Enough to find the program
 *  and its arguments; it doesn't expand anything. */
function words(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  let any = false;
  for (const ch of command) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else cur += ch;
    } else if (ch === "'" || ch === "\"") {
      quote = ch;
      any = true;
    } else if (/\s/.test(ch)) {
      if (cur !== "" || any) out.push(cur);
      cur = "";
      any = false;
    } else cur += ch;
  }
  if (cur !== "" || any) out.push(cur);
  return out;
}

/** Why a hook's `command` (with its `args`, when it has them) would run its stdin as a script, or undefined. */
export function hookReadsStdinAsScript(command: string, args?: readonly string[]): string | undefined {
  if (args !== undefined) return argvReadsStdin([command, ...args]);
  // A command line: each command of a list (`;`, `&&`, `||`, `&`, a newline), and of each pipeline its first command,
  // which is the one that gets the hook's stdin. A subshell or group (`( … )`, `{ …; }`) is looked inside the same way.
  for (const listItem of command.split(/;|&&|\|\||&|\n|\(|\)|\{|\}/)) {
    const first = listItem.split("|")[0]!.trim();
    if (first === "") continue;
    // A redirect from a file feeds it that file, not the hook's stdin.
    if (/(^|\s)<\s*[^\s&]/.test(first) && !/<\s*\/dev\/stdin/.test(first)) continue;
    const why = argvReadsStdin(words(first.replace(/\d*[<>]+&?\s*\S+/g, " ")));
    if (why !== undefined) return why;
  }
  return undefined;
}

/** The environment variable a placeholder's value travels in, for a `command` without `args`. */
export function hookPlaceholderEnv(part: { kind: "plugin" } | { kind: "data" } | { kind: "setting"; key: string }): string {
  if (part.kind === "plugin") return "CLOVER_PLUGIN_ROOT";
  if (part.kind === "data") return "CLOVER_PLUGIN_DATA";
  return `CLOVER_SETTING_${part.key.replace(/[^A-Za-z0-9_]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)}`;
}
