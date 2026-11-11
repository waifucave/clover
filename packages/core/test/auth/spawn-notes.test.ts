// C-M1's caller check: every process the daemon spawns for a session, an agent, a plugin or a hook is noted
// (`noteSpawned`), so a connection from it (or a descendant still under it) is never taken for the user. One test per
// spawn door that runs in the daemon: the fenced run (`runCommand`), an agent (`launchContained`), an agent's version
// probe (`runCapture`), and a plugin host process (`spawnHostProcess`). Each pid is noted while it runs and forgotten
// once it exits.
//
// Two spawns run outside the daemon, so a note there would land in another process's registry: the Claude Code hook
// shim (its own process, which Claude Code starts; the agent above it is noted) and the Linux supervisor worker (a
// thread of the sandbox shim's process; the shim is noted by `runCommand`).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { SessionProcesses } from "../../src/auth/clover-caller";
import { runCapture } from "../../src/agents/backend";
import { launchContained } from "../../src/agents/process/launch";
import { runCommand } from "../../src/fence/spawn";
import { spawnHostProcess } from "../../src/plugin-host/launch";

const caller = { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "luna" } as const;
const spies: { mockRestore(): void }[] = [];
afterEach(() => { for (const s of spies.splice(0)) s.mockRestore(); });

/** Records each pid noted from now on. */
function noted(): number[] {
  const pids: number[] = [];
  const add = SessionProcesses.shared.add.bind(SessionProcesses.shared);
  spies.push(spyOn(SessionProcesses.shared, "add").mockImplementation((pid, session) => { pids.push(pid); add(pid, session); }));
  return pids;
}

async function forgotten(pid: number): Promise<void> {
  const end = Date.now() + 5_000;
  while (SessionProcesses.shared.pids().has(pid)) {
    if (Date.now() > end) throw new Error(`pid ${pid} is still noted after it exited`);
    await Bun.sleep(20);
  }
}

describe.if(process.platform !== "win32")("every daemon spawn door notes its process", () => {
  test("a fenced run (runCommand): a bot's Bash, a plugin hook", async () => {
    const pids = noted();
    const r = await runCommand({ command: "echo $$", cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000, who: { caller } }, { shell: "sh", argv: ["/bin/sh", "-c", "echo $$"] });
    expect(r.kind).toBe("exited");
    const pid = Number((r as { stdout: string }).stdout.trim());
    expect(pids).toContain(pid);
    await forgotten(pid);
  });

  test("an agent's process (launchContained)", async () => {
    const pids = noted();
    const agent = launchContained({ command: "/bin/sleep", args: ["30"], cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" } });
    try {
      expect(agent.pid).toBeGreaterThan(0);
      expect(pids).toContain(agent.pid);
      expect(SessionProcesses.shared.pids().has(agent.pid)).toBe(true);
    } finally {
      process.kill(agent.pid, "SIGKILL");
    }
    await forgotten(agent.pid);
  });

  test("an agent's version probe (runCapture)", async () => {
    const pids = noted();
    const out = await runCapture("/bin/sh", ["-c", "echo $$"], { PATH: "/usr/bin:/bin" }, 10_000);
    const pid = Number(out.trim());
    expect(pids).toContain(pid);
    await forgotten(pid);
  });

  test("a plugin host process (spawnHostProcess)", async () => {
    const pids = noted();
    const host = spawnHostProcess({ cmd: ["/bin/sleep", "30"], env: { PATH: "/usr/bin:/bin" }, graceMs: 100 });
    try {
      expect(host.pid).toBeGreaterThan(0);
      expect(pids).toContain(host.pid!);
      expect(SessionProcesses.shared.pids().has(host.pid!)).toBe(true);
    } finally {
      host.kill();
    }
    await forgotten(host.pid!);
  });
});
