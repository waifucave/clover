import { afterAll, describe } from "bun:test";
import type { SpawnClaudeCodeProcess } from "@waifucave/clover-agent-sdk";
import { createEmbeddedSessionHost, embeddedVersionCheck, EMBEDDED_SHUTDOWN_BUDGET_MS, type EmbeddedSessionHost } from "../../src/runtime-sdk/embedded";

/**
 * A-M1 review S7: THE GATE FOR SESSION TESTS IS THE EMBEDDED RUNTIME, NOT THE `winter` BINARY. Every session
 * (code, dispatch, chat) runs the SDK embedded in clover-core, one Worker per session, so a test that boots a
 * daemon and drives a session needs exactly what the daemon needs: the linked SDK runtime at the version core
 * pins. That is part of core's own install, on every OS, so a missing or mismatched one FAILS here (it would
 * break every session) instead of skipping, and nothing reads `CLOVER_RUNTIME_EXECUTABLE`.
 *
 * `fn` receives a spawn hook for a test that drives `query()` directly rather than through a daemon: each call
 * runs one session in a new Worker of one embedded host, which is shut down after the block.
 *
 * The binary gate (`helpers/winter-binary.ts`) stays only for the real-child projector tests and lane K's.
 */
export const describeWithEmbeddedRuntime = (name: string, fn: (spawn: SpawnClaudeCodeProcess) => void) => {
  const unavailable = embeddedVersionCheck();
  if (unavailable !== undefined) throw new Error(`the embedded runtime is unavailable, so no session can run: ${unavailable.message}`);
  return describe(name, () => {
    let host: EmbeddedSessionHost | undefined;
    const spawn: SpawnClaudeCodeProcess = (options) => (host ??= createEmbeddedSessionHost()).spawn(options);
    afterAll(async () => { await host?.shutdown(EMBEDDED_SHUTDOWN_BUDGET_MS); });
    fn(spawn);
  });
};
