// The in-process agents' sandbox (Clover's coding agent and lane A's `clover` subagents). They run on the embedded
// runtime with its sandbox required, and that sandbox is Seatbelt's, so only macOS has it for now. Elsewhere the
// runtime refuses every sandboxed tool call ("refusing to silently run unsandboxed"); the backends say so at detection
// instead, so a delegation there, on this computer or for another one, is refused up front with the reason, not left
// to fail call by call. Lane C's Linux fence brings them to Linux.
import { existsSync } from "node:fs";
import type { AgentDetection } from "../../contracts/agent-backend";

const SEATBELT = "/usr/bin/sandbox-exec";

/** Whether the embedded runtime's sandbox can run here. */
export function inProcessSandboxReady(): boolean {
  return process.platform === "darwin" && existsSync(SEATBELT);
}

/** An in-process backend's detection where its sandbox can't run: not available, with the reason. */
export function notAvailableHere(id: string, version?: string): AgentDetection {
  const where = process.platform === "linux" ? "on Linux" : process.platform === "win32" ? "on Windows" : process.platform === "darwin" ? "on this Mac (its sandbox-exec is missing)" : `on ${process.platform}`;
  return {
    installed: false, identityOk: true, versionOk: true, sandboxed: false, ...(version === undefined ? {} : { version }),
    reason: `${id} runs in the embedded runtime's sandbox, which is macOS-only for now: it isn't available ${where} yet`,
  };
}
