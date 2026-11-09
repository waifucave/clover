// `clover-core __worker-entry-probe`: whether a compiled Worker entry resolves inside the built binary, on every OS
// (build:daemon runs it on each core it builds for its own machine). The core starts its Workers by plain relative
// names (`./fd-receiver-worker.ts`, `./embedded-worker.ts`), which resolve only while every compile entrypoint keeps
// its name (compile:core's `--root src`). This loads the fd receiver's entry, whose top level only sets its message
// handler (no descriptor, FFI or OS feature until a message comes, which this never sends), and reports whether it
// loaded: a missing entry is a ModuleNotFound error within milliseconds. It touches no home, Keychain or daemon.
import { COMPILED_FD_RECEIVER_WORKER_ENTRY } from "../../core/src/cowork/native/fd-channel";

export async function runWorkerEntryProbe(entry: string = COMPILED_FD_RECEIVER_WORKER_ENTRY, settleMs = 1_500): Promise<{ ok: boolean; entry: string; error?: string }> {
  return await new Promise((resolve) => {
    let opened = false;
    let settled = false;
    const worker = new Worker(entry);
    const done = (r: { ok: boolean; entry: string; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(r);
    };
    worker.addEventListener("open", () => { opened = true; });
    worker.addEventListener("error", (e) => done({ ok: false, entry, error: (e as ErrorEvent).message ?? "the Worker failed" }));
    const timer = setTimeout(() => done(opened ? { ok: true, entry } : { ok: false, entry, error: "the Worker never opened" }), settleMs);
  });
}
