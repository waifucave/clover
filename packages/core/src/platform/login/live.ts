// The live `LoginOsDeps`: real launchctl / systemctl --user / schtasks, through an injectable runner
// so a test can check the commands without running them. Every process is spawned with Bun.spawn:
// on Linux `node:child_process` stalled in spike S7, and it stays out of lane C's paths until that is
// isolated.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoginOsDeps, TaskDef } from "./manager";
import { appTaskName, appUnitName, loginLabel, loginUnitPath, schtasksTaskName, systemdUnitName, type LoginSpec } from "./render";

export interface RunResult { readonly ok: boolean; readonly out: string }
/** Runs one command and reports whether it exited 0, with its stdout and stderr. */
export type Runner = (argv: readonly string[]) => Promise<RunResult>;

export const bunRunner: Runner = async (argv) => {
  try {
    const proc = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { ok: (await proc.exited) === 0, out: out + err };
  } catch (e) {
    return { ok: false, out: (e as Error).message };
  }
};

/** The launchd domain for user agents: the GUI session's (`gui/<uid>`) when there is one, else
 *  `user/<uid>` (an SSH login with no GUI session). */
export async function launchdDomain(run: Runner, uid: number = process.getuid?.() ?? 0): Promise<string> {
  return (await run(["launchctl", "print", `gui/${uid}`])).ok ? `gui/${uid}` : `user/${uid}`;
}

/** The current Windows user's SID, from `whoami /user`: the form of `<UserId>` Task Scheduler resolves
 *  on any machine. (`USERDOMAIN\USERNAME` doesn't: over SSH on a workgroup machine USERDOMAIN reads
 *  WORKGROUP, which no account belongs to, and the task is refused.) */
export async function windowsUserSid(run: Runner): Promise<string | undefined> {
  const r = await run(["whoami", "/user", "/fo", "csv", "/nh"]);
  const m = /"(S-1-[\d-]+)"/.exec(r.out);
  return r.ok && m ? m[1] : undefined;
}

/** Writes a task's XML as UTF-16LE with a BOM (what `schtasks /XML` reads) to a temp file. */
export type TaskXmlWriter = (xml: string) => { path: string; cleanup(): void };

export const tempTaskXml: TaskXmlWriter = (xml) => {
  const dir = mkdtempSync(join(tmpdir(), "clover-task-"));
  const path = join(dir, "task.xml");
  writeFileSync(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
  return { path, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* raced */ } } };
};

/** The daemon's task's logon trigger, from `schtasks /Query /XML` output (which may be UTF-16). */
export function logonTriggerState(queryXml: string): "on" | "off" | "absent" {
  const text = queryXml.replace(/\0/g, "");
  const m = /<LogonTrigger>[\s\S]*?<Enabled>(true|false)<\/Enabled>/i.exec(text);
  if (m) return m[1]!.toLowerCase() === "true" ? "on" : "off";
  // A logon trigger with no <Enabled> element is enabled (the schema's default).
  return /<LogonTrigger\b/i.test(text) ? "on" : "off";
}

export function liveLoginOsDeps(run: Runner = bunRunner, taskXml: TaskXmlWriter = tempTaskXml): LoginOsDeps {
  async function createTask(t: TaskDef): Promise<boolean> {
    const file = taskXml(t.xml);
    try { return (await run(["schtasks", "/Create", "/F", "/TN", t.name, "/XML", file.path])).ok; }
    finally { file.cleanup(); }
  }
  return {
    async register(spec, { loginOn, tasks }) {
      if (spec.os === "darwin") {
        // Login start off: the plist is parked and a running job is left alone.
        if (!loginOn) return true;
        const domain = await launchdDomain(run);
        const target = `${domain}/${loginLabel(spec.profile)}`;
        await run(["launchctl", "enable", target]); // clears a `launchctl disable` override, if any
        if ((await run(["launchctl", "print", target])).ok) return true; // loaded already: leave it running
        return (await run(["launchctl", "bootstrap", domain, loginUnitPath(spec)!])).ok;
      }
      if (spec.os === "linux") {
        await run(["systemctl", "--user", "daemon-reload"]);
        const unit = systemdUnitName(spec.profile);
        // `disable` without `--now`: the running pair keeps running and stays startable.
        return (await run(loginOn ? ["systemctl", "--user", "enable", "--now", unit] : ["systemctl", "--user", "disable", unit])).ok;
      }
      let ok = true;
      for (const t of tasks) ok = (await createTask(t)) && ok;
      return ok;
    },
    async unregister(spec) {
      if (spec.os === "darwin") {
        const domain = await launchdDomain(run);
        await run(["launchctl", "bootout", `${domain}/${loginLabel(spec.profile)}`]);
        return;
      }
      if (spec.os === "linux") {
        await run(["systemctl", "--user", "disable", "--now", systemdUnitName(spec.profile)]);
        await run(["systemctl", "--user", "stop", appUnitName(spec.profile)]);
        await run(["systemctl", "--user", "daemon-reload"]);
        return;
      }
      for (const name of [schtasksTaskName(spec.profile), appTaskName(spec.profile)]) {
        await run(["schtasks", "/End", "/TN", name]);
        await run(["schtasks", "/Delete", "/F", "/TN", name]);
      }
    },
    async query(spec) {
      if (spec.os === "darwin") {
        const domain = await launchdDomain(run);
        return (await run(["launchctl", "print", `${domain}/${loginLabel(spec.profile)}`])).ok ? "on" : "absent";
      }
      if (spec.os === "linux") {
        const r = await run(["systemctl", "--user", "is-enabled", systemdUnitName(spec.profile)]);
        const word = r.out.trim().split(/\s+/)[0] ?? "";
        return word === "enabled" ? "on" : word === "disabled" ? "off" : "absent";
      }
      const r = await run(["schtasks", "/Query", "/TN", schtasksTaskName(spec.profile), "/XML"]);
      return r.ok ? logonTriggerState(r.out) : "absent";
    },
  };
}

/** The OS's own stop, when the clean one didn't finish: SIGTERM through launchd or systemd (which
 *  `supervise` forwards, so the daemon still stops in order), or `schtasks /End` on Windows, which
 *  ends the task's processes outright. */
export async function stopThroughOs(spec: LoginSpec, run: Runner): Promise<boolean> {
  if (spec.os === "darwin") {
    const domain = await launchdDomain(run);
    return (await run(["launchctl", "kill", "SIGTERM", `${domain}/${loginLabel(spec.profile)}`])).ok;
  }
  if (spec.os === "linux") return (await run(["systemctl", "--user", "stop", systemdUnitName(spec.profile)])).ok;
  return (await run(["schtasks", "/End", "/TN", schtasksTaskName(spec.profile)])).ok;
}
