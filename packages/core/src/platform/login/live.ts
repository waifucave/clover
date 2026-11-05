// The live `LoginOsDeps`: real launchctl / systemctl --user / schtasks. Never imported by a test;
// tests pass their own fakes to the manager.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schtasksTaskName, systemdUnitName } from "./render";
import type { LoginOsDeps } from "./manager";
import type { LoginSpec } from "./render";
import { loginUnitPath, loginLabel } from "./render";

async function run(cmd: string[]): Promise<{ ok: boolean; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { ok: (await proc.exited) === 0, out };
}

export function liveLoginOsDeps(): LoginOsDeps {
  return {
    async register(spec: LoginSpec, xml: string): Promise<boolean> {
      if (spec.os === "darwin") {
        const uid = process.getuid!();
        const path = loginUnitPath(spec)!;
        await run(["launchctl", "bootout", `gui/${uid}/${loginLabel(spec.profile)}`]);
        return (await run(["launchctl", "bootstrap", `gui/${uid}`, path])).ok;
      }
      if (spec.os === "linux") {
        await run(["systemctl", "--user", "daemon-reload"]);
        return (await run(["systemctl", "--user", "enable", "--now", systemdUnitName(spec.profile)])).ok;
      }
      const tmp = mkdtempSync(join(tmpdir(), "clover-task-"));
      const xmlPath = join(tmp, "task.xml");
      try {
        writeFileSync(xmlPath, "﻿" + xml, "utf16le");
        return (await run(["schtasks", "/Create", "/F", "/TN", schtasksTaskName(spec.profile), "/XML", xmlPath])).ok;
      } finally { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* raced */ } }
    },
    async unregister(spec: LoginSpec): Promise<void> {
      if (spec.os === "darwin") { await run(["launchctl", "bootout", `gui/${process.getuid!()}/${loginLabel(spec.profile)}`]); return; }
      if (spec.os === "linux") { await run(["systemctl", "--user", "disable", "--now", systemdUnitName(spec.profile)]); return; }
      await run(["schtasks", "/Delete", "/F", "/TN", schtasksTaskName(spec.profile)]);
    },
    async isRegistered(spec: LoginSpec): Promise<boolean> {
      if (spec.os === "darwin") return (await run(["launchctl", "print", `gui/${process.getuid!()}/${loginLabel(spec.profile)}`])).ok;
      if (spec.os === "linux") return (await run(["systemctl", "--user", "is-enabled", systemdUnitName(spec.profile)])).ok;
      return (await run(["schtasks", "/Query", "/TN", schtasksTaskName(spec.profile)])).ok;
    },
  };
}
