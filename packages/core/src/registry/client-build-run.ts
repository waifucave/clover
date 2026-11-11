// One load-time build of a plugin's TypeScript client entry (`client-builds.ts` runs it in a child of its own,
// `client-build-main.ts`): the registry's builder (`buildPluginModule`, side `client`) into a staging folder, then
// checked. Building is not running: nothing of the plugin's executes here.
//
// What `buildPluginModule` already guarantees, as it does for the bundled plugins' release build (`ship.ts`):
// * macros off (a `with { type: "macro" }` import fails the build), and no bundler plugin on the client side;
// * no `define` or loader config of the plugin's (only `process.env.NODE_ENV` and the dirname shims are defined);
// * one module, no chunks, no source map;
// * the output's bare imports checked: only `CLIENT_BARE_IMPORTS`, with the existing message for anything else;
// * no load the scan can't check (`runtimeLoadProblems`), and the `forbid` strings (here: the plugin's folder, the
//   user's home and name) absent from the output.
// What this adds:
// * the entry and every file the bundler read (its metafile's inputs) inside the plugin's real folder, after links: a
//   tsconfig `paths`/`extends`/`jsxImportSource` or a package.json `imports` that reaches outside fails the build;
// * no stylesheet or file asset out of a load-time build (a client lists its stylesheets in `client.css`, which the
//   app cleans; a built one would skip that);
// * bounds: the inputs' count and bytes, and the output's bytes;
// * messages with the plugin's folder cut to relative paths and the user's home to `~`, never an absolute path.
// The child itself (the caller's side) adds the rest: a fresh empty working folder, no environment of the daemon's,
// Clover's own bunfig, the fence (macOS), a time limit and a memory watchdog.
import { createHash } from "node:crypto";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { buildMachineStrings, buildPluginModule, PluginBuildError } from "./build";

/** The bounds of one load-time build. */
export const CLIENT_BUILD_LIMITS = {
  /** Files the bundler may read into it. */
  maxInputs: 4_000,
  /** Their bytes, together. */
  maxInputBytes: 64 * 1024 * 1024,
  /** The built module's bytes. */
  maxOutputBytes: 16 * 1024 * 1024,
  /** Wall clock, from the child's start (the caller kills it then). */
  timeoutMs: 60_000,
  /** The child's resident memory (the caller's watchdog kills it above this). */
  maxRssBytes: 1536 * 1024 * 1024,
} as const;

/** What the caller hands the child. */
export interface ClientBuildJob {
  /** The plugin's folder (its real path is taken here). */
  root: string;
  /** `client.entry`, relative to `root`. */
  entry: string;
  /** The staging folder the module is written into (empty; the child's working folder). */
  outDir: string;
  /** The user's home and name, for the strings the output may not hold. */
  home: string;
  user: string;
  maxInputs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
}

/** The child's one answer. */
export type ClientBuildResult =
  | { ok: true; file: "index.js"; sha256: string; bytes: number; imports: string[] }
  | { ok: false; message: string };

/** The built module's name in its folder. */
export const BUILT_CLIENT_FILE = "index.js";

const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** A message with the plugin's folder cut to relative paths and the user's home to `~`. */
export function relativeMessage(text: string, root: string, home: string): string {
  let out = text;
  for (const r of [root, ...(root.startsWith("/private/") ? [root.slice("/private".length)] : [])]) out = out.split(r + sep).join("").split(r).join(".");
  if (home.length > 1) out = out.split(home).join("~");
  return out;
}

export async function runClientBuild(job: ClientBuildJob): Promise<ClientBuildResult> {
  let root: string;
  try {
    root = realpathSync(job.root);
  } catch {
    return { ok: false, message: "the plugin's folder isn't there" };
  }
  const fail = (message: string): ClientBuildResult => ({ ok: false, message: relativeMessage(message, root, job.home) });
  if (job.entry === "" || isAbsolute(job.entry) || job.entry.split(/[\\/]/).includes("..")) return fail(`client.entry ${JSON.stringify(job.entry)} isn't a path inside the plugin`);
  let entry: string;
  try {
    entry = realpathSync(join(root, job.entry));
  } catch {
    return fail(`client.entry ${job.entry} isn't there`);
  }
  if (!inside(root, entry)) return fail(`client.entry ${job.entry} leads outside the plugin`);
  // The working folder is the staging folder, which holds nothing: no bunfig, .env or package.json of anyone's.
  if (readdirSync(job.outDir).length > 0) return fail("the build's folder isn't empty");
  const outFile = join(job.outDir, BUILT_CLIENT_FILE);
  let built: Awaited<ReturnType<typeof buildPluginModule>>;
  try {
    built = await buildPluginModule({
      entry, outFile, side: "client",
      forbid: buildMachineStrings([{ path: root, label: "the plugin's folder" }], job.home, job.user),
    });
  } catch (e) {
    const lines = e instanceof PluginBuildError ? e.problems : [e instanceof Error ? e.message : String(e)];
    return fail(lines.slice(0, 8).join("; "));
  }
  // Every file the bundler read is the plugin's own.
  const maxInputs = job.maxInputs ?? CLIENT_BUILD_LIMITS.maxInputs;
  if (built.inputs.length > maxInputs) return fail(`the client reads ${built.inputs.length} files; a client built at load reads at most ${maxInputs}`);
  let inputBytes = 0;
  for (const input of built.inputs) {
    let real: string;
    try {
      real = realpathSync(input);
    } catch {
      return fail(`the build read ${input}, which isn't there now`);
    }
    if (!inside(root, real)) return fail(`the build read a file outside the plugin (${relative(root, real).split(sep).slice(0, 3).join("/")}…); a plugin's client is built from its own files only`);
    inputBytes += statSync(real).size;
  }
  const maxInputBytes = job.maxInputBytes ?? CLIENT_BUILD_LIMITS.maxInputBytes;
  if (inputBytes > maxInputBytes) return fail(`the client's files are ${inputBytes} bytes; a client built at load reads at most ${maxInputBytes}`);
  if (built.css.length > 0 || built.assets.length > 0) {
    return fail("the client imports a stylesheet or a file; a client built at load imports code only (list its stylesheets in client.css)");
  }
  const bytes = Buffer.byteLength(built.source);
  const maxOutputBytes = job.maxOutputBytes ?? CLIENT_BUILD_LIMITS.maxOutputBytes;
  if (bytes > maxOutputBytes) return fail(`the built client is ${bytes} bytes; at most ${maxOutputBytes}`);
  // Only the module is left in the folder.
  const left = readdirSync(job.outDir).filter((f) => f !== BUILT_CLIENT_FILE);
  if (left.length > 0) return fail(`the build wrote more than the module (${left.slice(0, 3).join(", ")})`);
  return { ok: true, file: BUILT_CLIENT_FILE, sha256: createHash("sha256").update(built.source).digest("hex"), bytes, imports: built.imports };
}
