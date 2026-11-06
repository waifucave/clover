// The fenced process (C-M2 part 2): a command run under the fence, for bots' Bash and, on macOS, a hook's command
// (spec §9.1; `spawn.ts`'s door). One sandbox per OS, built from the fence's `SandboxPolicy` at each run, so a
// development folder added or a plugin's data folder made since is in it:
//   macOS    Seatbelt (`sandbox-exec -p`, `macos-profile.ts`)
//   Linux    bubblewrap (C-M2 part 2, next)
//   Windows  not yet: the door says so and refuses
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Os } from "@waifucave/clover-protocol";
import type { CloverFence } from "./fence";
import { macFenceProfile } from "./macos-profile";
import { runCommand, type FencedSpawner } from "./spawn";

export interface FencedProcessOptions {
  readonly fence: CloverFence;
  readonly os?: Os;
  /** macOS's per-user temp folder; default from `getconf DARWIN_USER_TEMP_DIR`. */
  readonly perUserTemp?: () => string | null;
}

let tempCache: string | null | undefined;
function darwinUserTemp(): string | null {
  if (tempCache !== undefined) return tempCache;
  tempCache = null;
  try {
    const raw = spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).stdout?.trim();
    if (raw) tempCache = require("node:fs").realpathSync(raw.replace(/\/+$/, "")) as string;
  } catch { /* none */ }
  return tempCache;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export function fencedSpawner(o: FencedProcessOptions): FencedSpawner {
  const os = o.os ?? o.fence.os;
  if (os === "macos") {
    if (!existsSync(SANDBOX_EXEC)) return closed("macOS's sandbox (sandbox-exec) isn't on this Mac");
    return {
      available: true,
      run: (r) => {
        const profile = macFenceProfile({ policy: o.fence.policy(), cloverHome: o.fence.cloverHome, perUserTemp: (o.perUserTemp ?? darwinUserTemp)() });
        return runCommand(r, { shell: "sh", argv: [SANDBOX_EXEC, "-p", profile, "/bin/sh", "-c", r.command] });
      },
    };
  }
  return closed(os === "linux" ? "the Linux sandbox comes with C-M2 part 2" : "the Windows sandbox isn't built yet");
}

function closed(reason: string): FencedSpawner {
  return { available: false, run: async () => ({ kind: "refused", reason: `a fenced process can't be started here: ${reason}` }) };
}
