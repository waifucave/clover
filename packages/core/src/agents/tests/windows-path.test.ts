// An agent backend's bare command on Windows (#233's review: one check on the Windows CI job). The manifest names the
// same bare program on every OS (`cursor-agent`, `gemini`), and the PATH lookup finds its `.exe` or, for an npm bin,
// its `.cmd`, never the extensionless shell script or the `.ps1` npm writes beside it; a `.cmd` then runs through
// `cmd.exe`. Measured on a Windows VM with Bun 1.3.14 and 1.4.4, PATHEXT set or not; this keeps it measured in CI.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolveProgram } from "../backend";
import { spawnPlan } from "../process/launch";

const onWindows = process.platform === "win32";
const temps: string[] = [];
afterAll(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

test.if(onWindows)("a bare command finds its .exe or its .cmd on PATH, never npm's sh script or .ps1, and a .cmd runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "clover-k-win-"));
  temps.push(dir);
  // A real program as `exeagent.exe`, and an npm-style bin: `cmdagent.cmd` with its sh script and .ps1 beside it.
  copyFileSync(process.execPath, join(dir, "exeagent.exe"));
  // `%~1`: the argument as the program gets it, without the quotes `cmd.exe /s /c` keeps around it (npm's shims pass
  // `%*` on to node, which reads them the same way).
  writeFileSync(join(dir, "cmdagent.cmd"), "@echo off\r\necho cmdagent %~1\r\n");
  writeFileSync(join(dir, "cmdagent"), "#!/bin/sh\necho sh\n");
  writeFileSync(join(dir, "cmdagent.ps1"), "echo ps1\n");
  for (const pathext of [process.env["PATHEXT"], undefined]) {
    const saved = process.env["PATHEXT"];
    if (pathext === undefined) delete process.env["PATHEXT"];
    try {
      expect(basename(resolveProgram("exeagent", dir) ?? "").toLowerCase()).toBe("exeagent.exe");
      expect(basename(resolveProgram("cmdagent", dir) ?? "").toLowerCase()).toBe("cmdagent.cmd");
    } finally {
      if (saved !== undefined) process.env["PATHEXT"] = saved;
    }
  }
  const found = resolveProgram("cmdagent", dir)!;
  const plan = spawnPlan(found, ["acp"]);
  expect(plan.verbatim).toBe(true);
  const out = spawnSync(plan.file, plan.args, { windowsVerbatimArguments: true, encoding: "utf8" });
  expect(out.stdout.trim()).toBe("cmdagent acp");
});

test.if(!onWindows)("off Windows, a .cmd is spawned as given (the Windows CI job runs the check above)", () => {
  expect(spawnPlan("/x/agent.cmd", ["acp"], "linux")).toEqual({ file: "/x/agent.cmd", args: ["acp"], verbatim: false });
});
