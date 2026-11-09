// No Bun macros in a process that runs code Clover didn't write (#289, and its Worker follow-up). A macro (an import
// `with { type: "macro" }`) runs its module's code while the file importing it is transpiled. `--no-macros`, a bunfig's
// `macros = false`, BUN_OPTIONS and a Worker's execArgv hold a process's MAIN thread only: on Bun 1.4.4 a Worker runs a
// macro whatever its process was started with (measured), and a compiled binary takes no Bun flag at run time anyway.
//
// So a process running foreign code is guarded from inside, in every thread it can have:
//   - installNoMacrosGuard: a Bun.plugin onResolve that refuses any import whose importer is a macro's frame
//     (`macro//<hash>.js`), before the macro's module loads. Every other import falls through untouched (an onLoad
//     couldn't: at run time it must return contents, which loses CommonJS interop). The plugin can't be cleared.
//   - refuseWorkers: the process starts no thread at all. Both Worker constructors, the web one and
//     node:worker_threads', are replaced (locked) before the foreign code runs, so no thread can escape the guard; a
//     process whose code must start Workers instead preloads the guard into each one (lane B's plugin host).
//
// One owner, one text: lane B's plugin guard is generated plain JS and can't import this file at run time, so it builds
// its guard from MACRO_IMPORTER.source and MACRO_REFUSAL_SUFFIX, and pins its generated copy to these.
//
// A known limit, measured on Bun 1.4.4: a Bun.plugin never sees an import of a builtin. `import("bun")`, `"bun:ffi"`,
// `"node:child_process"` and the rest load whatever onResolve says, and `build.module()` refuses to override a builtin.
// No loader in this process can withhold them; for the model's scripts the boundary is the seatbelt the daemon runs
// the worker in (workflows/sandbox.ts: no writes, no network, exec of itself only).
import { createRequire } from "node:module";

/** A macro's module is resolved from its macro frame: `macro//<hash>.js` (`macro://` on some paths). */
export const MACRO_IMPORTER = /^macro:?\/\//;

/** The refusal's text after the path, kept so lane B's generated guard can paste it in. */
export const MACRO_REFUSAL_SUFFIX = ': a Bun macro (an import with { type: "macro" }) runs code while its file loads, and Clover runs none';

/** The refusal for a macro's module at `path`. */
export function macroRefusal(path: string): string {
  return `refused ${path}${MACRO_REFUSAL_SUFFIX}`;
}

let installed = false;

/**
 * Refuses every macro in this thread from now on (see the header). Idempotent. `fail` is how the refusal surfaces
 * (default: throw an Error, which fails the import that reached the macro).
 */
export function installNoMacrosGuard(fail: (message: string) => never = (message) => { throw new Error(message); }): void {
  if (installed) return;
  Bun.plugin({
    name: "clover-no-macros",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (MACRO_IMPORTER.test(args.importer ?? "")) fail(macroRefusal(args.path));
        return undefined;
      });
    },
  });
  // The guard stays registered: code that reaches `Bun` (an `import("bun")`) can't clear it.
  try {
    Object.defineProperty(Bun.plugin, "clearAll", { value: () => fail("the no-macros guard stays"), writable: false, configurable: false });
  } catch { /* already locked */ }
  installed = true;
}

/**
 * This process starts no Worker from now on: `globalThis.Worker` and `node:worker_threads`' `Worker` throw, locked. A
 * Worker would run outside installNoMacrosGuard (a Bun.plugin, and a process preload, hold the thread they're in).
 * Call it before any foreign code runs, and before anything imports `node:worker_threads` as a module.
 */
let refusing: (() => never) | undefined;

export function refuseWorkers(who: string): void {
  refusing ??= function Worker(): never {
    throw new Error(`${who} starts no Worker: a Worker would run outside its no-macros guard`);
  };
  const lock = (target: object): void => {
    try { Object.defineProperty(target, "Worker", { value: refusing, writable: false, configurable: false }); } catch { /* already locked */ }
  };
  lock(globalThis);
  lock(createRequire(import.meta.url)("node:worker_threads") as object);
}

/**
 * Whether the Worker refusal holds where foreign code would reach it. A namespace of `node:worker_threads` made
 * before refuseWorkers (a module of this process imported it first) keeps the real constructor, and it can't be
 * patched (it is frozen): then this throws, and the caller runs nothing.
 */
export async function verifyWorkersRefused(who: string): Promise<void> {
  const ns = (await import("node:worker_threads")) as { Worker?: unknown; default?: { Worker?: unknown } };
  const live = [ns.Worker, ns.default?.Worker, (globalThis as { Worker?: unknown }).Worker];
  if (refusing === undefined || live.some((W) => W !== refusing)) {
    throw new Error(`${who}: a Worker constructor is still live (node:worker_threads was imported before the guard), so nothing runs`);
  }
}

/**
 * Both, for a process that runs the model's code (the computer-use automation worker, the workflow worker): installed
 * at once, and the promise settles when the Worker refusal is verified (verifyWorkersRefused). Run nothing before it.
 */
export function guardScriptProcess(who: string): Promise<void> {
  installNoMacrosGuard();
  refuseWorkers(who);
  return verifyWorkersRefused(who);
}
